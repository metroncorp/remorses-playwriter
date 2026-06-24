// Cron handler that enforces per-org cloud spend budgets.
// Runs every minute. Does 1 D1 read + 1 batch write per invocation.
//
// Flow:
//   1. Single query: all active cloud_session rows with org spend/budget
//   2. Parallel Browser Use API calls to read costs per session
//   3. Compute deltas (current total cost - lastTotalCostCents)
//   4. Single batch write: update session costs + org cumulative spend
//   5. If any org exceeds budget or has no subscription: stop VMs + delete rows
//
// Budget resets each billing period: when subscription.currentPeriodStart
// changes (new month), cloudSpendCents is reset to 0.
//
// Total cost = browserCost + proxyCost from Browser Use API. This ensures
// budget enforcement covers VM runtime, not just proxy bandwidth.

import { env } from 'cloudflare:workers'
import * as orm from 'drizzle-orm'
import * as schema from 'db/schema'
import { getDb } from './db.ts'
import { BrowserUseClient, BrowserUseApiError } from './lib/browser-use.ts'
import { ACTIVE_SUBSCRIPTION_STATUSES } from './lib/billing-rules.ts'

function getBrowserUse() {
  return new BrowserUseClient({ apiKey: env.BROWSER_USE_API_KEY as string })
}

/** Parse Browser Use cost string (e.g. "0.05") to integer cents. */
function parseCostToCents(cost: string): number {
  const parsed = parseFloat(cost)
  if (Number.isNaN(parsed)) return 0
  return Math.round(parsed * 100)
}

export async function enforceProxyBudgets(): Promise<void> {
  const db = getDb()
  const bu = getBrowserUse()

  // 1. Single D1 read: all cloud sessions joined with org + subscription data.
  //    LEFT JOIN subscription so we can detect orgs without active subscriptions.
  //    Skip pending placeholder rows (they have no real BU VM yet).
  const rows = await db
    .select({
      session: schema.cloudSession,
      orgId: schema.org.id,
      cloudSpendCents: schema.org.cloudSpendCents,
      cloudBudgetCents: schema.org.cloudBudgetCents,
      cloudSpendPeriodStart: schema.org.cloudSpendPeriodStart,
      subscriptionPeriodStart: schema.subscription.currentPeriodStart,
      subscriptionStatus: schema.subscription.status,
    })
    .from(schema.cloudSession)
    .innerJoin(schema.org, orm.eq(schema.cloudSession.orgId, schema.org.id))
    .leftJoin(schema.subscription, orm.and(
      orm.eq(schema.subscription.orgId, schema.org.id),
      orm.inArray(schema.subscription.status, [...ACTIVE_SUBSCRIPTION_STATUSES]),
    ))
    .where(
      // Skip pending placeholder rows (they have no real BU VM yet)
      orm.not(orm.like(schema.cloudSession.browserUseSessionId, 'pending-%')),
    )

  if (rows.length === 0) return

  // 2. Parallel BU API calls to get current costs per session.
  //    Use allSettled so one failure doesn't block the rest.
  const buResults = await Promise.allSettled(
    rows.map((row) => {
      return bu.getBrowser(row.session.browserUseSessionId)
    }),
  )

  // 3. Compute per-session deltas and group by org.
  const orgDeltas = new Map<string, {
    totalDeltaCents: number
    cloudSpendCents: number
    cloudBudgetCents: number
    cloudSpendPeriodStart: number | null
    subscriptionPeriodStart: number | null
    hasActiveSubscription: boolean
    sessionUpdates: Array<{ id: string; buSessionId: string; newCostCents: number; prevCostCents: number }>
    killSessionIds: string[]
  }>()

  const deadSessionIds: string[] = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const result = buResults[i]!

    // BU API failed. Treat 404 and 400 (malformed ID) as dead.
    // Transient errors (500, rate limit, network) leave the row intact
    // so the next cron tick can retry.
    if (result.status === 'rejected') {
      const err = result.reason
      if (err instanceof BrowserUseApiError && (err.status === 404 || err.status === 400)) {
        deadSessionIds.push(row.session.id)
      }
      continue
    }

    // Parse total cost (browserCost + proxyCost) even for stopped VMs
    // so we capture the final spend between the last cron tick and when
    // the session ended.
    const vm = result.value
    const currentCostCents = parseCostToCents(vm.browserCost) + parseCostToCents(vm.proxyCost)
    const deltaCents = Math.max(0, currentCostCents - row.session.lastTotalCostCents)

    if (vm.status !== 'active') {
      deadSessionIds.push(row.session.id)
    }

    let orgEntry = orgDeltas.get(row.orgId)
    if (!orgEntry) {
      orgEntry = {
        totalDeltaCents: 0,
        cloudSpendCents: row.cloudSpendCents,
        cloudBudgetCents: row.cloudBudgetCents,
        cloudSpendPeriodStart: row.cloudSpendPeriodStart,
        subscriptionPeriodStart: row.subscriptionPeriodStart,
        hasActiveSubscription: row.subscriptionStatus != null,
        sessionUpdates: [],
        killSessionIds: [],
      }
      orgDeltas.set(row.orgId, orgEntry)
    }

    orgEntry.totalDeltaCents += deltaCents
    orgEntry.sessionUpdates.push({
      id: row.session.id,
      buSessionId: row.session.browserUseSessionId,
      newCostCents: currentCostCents,
      prevCostCents: row.session.lastTotalCostCents,
    })
  }

  // 4. Build batch writes: update session costs + org spend.
  //    Detect orgs over budget or without subscription and queue termination.
  //
  //    Uses atomic SQL increments for org spend to avoid race conditions
  //    if two cron invocations overlap. The session baseline update uses a
  //    conditional WHERE to prevent double-counting: if another invocation
  //    already advanced the baseline, our update is a no-op.
  const statements: Parameters<typeof db.batch>[0] = []

  for (const [orgId, entry] of orgDeltas) {
    // Detect billing period rollover: if the subscription's currentPeriodStart
    // differs from the org's stored cloudSpendPeriodStart, a new billing cycle
    // started. Reset cumulative spend to 0 and start fresh.
    const periodRolledOver = entry.subscriptionPeriodStart != null
      && entry.cloudSpendPeriodStart !== entry.subscriptionPeriodStart

    if (periodRolledOver) {
      // Reset spend for new billing period, then add this tick's delta
      statements.push(
        db.update(schema.org)
          .set({
            cloudSpendCents: entry.totalDeltaCents,
            cloudSpendPeriodStart: entry.subscriptionPeriodStart,
            updatedAt: Date.now(),
          })
          .where(orm.eq(schema.org.id, orgId)),
      )
    } else if (entry.totalDeltaCents > 0) {
      // Atomic increment: safe against overlapping cron invocations.
      statements.push(
        db.update(schema.org)
          .set({
            cloudSpendCents: orm.sql`${schema.org.cloudSpendCents} + ${entry.totalDeltaCents}`,
            updatedAt: Date.now(),
          })
          .where(orm.eq(schema.org.id, orgId)),
      )
    }

    // Conditionally update session baselines: only advance if the baseline
    // hasn't already been updated by a concurrent cron run.
    for (const su of entry.sessionUpdates) {
      statements.push(
        db.update(schema.cloudSession)
          .set({ lastTotalCostCents: su.newCostCents })
          .where(orm.and(
            orm.eq(schema.cloudSession.id, su.id),
            orm.eq(schema.cloudSession.lastTotalCostCents, su.prevCostCents),
          )),
      )
    }

    // Kill sessions if org has no active subscription (cancelled/expired)
    if (!entry.hasActiveSubscription) {
      for (const su of entry.sessionUpdates) {
        entry.killSessionIds.push(su.id)
      }
      continue
    }

    // Kill sessions if org exceeded budget. For overlapping cron safety
    // we read the pessimistic value: current DB spend + our delta.
    const estimatedSpend = periodRolledOver
      ? entry.totalDeltaCents
      : entry.cloudSpendCents + entry.totalDeltaCents
    if (estimatedSpend >= entry.cloudBudgetCents) {
      for (const su of entry.sessionUpdates) {
        entry.killSessionIds.push(su.id)
      }
    }
  }

  // Clean up dead sessions discovered during BU API checks
  if (deadSessionIds.length > 0) {
    statements.push(
      db.delete(schema.cloudSession)
        .where(orm.inArray(schema.cloudSession.id, deadSessionIds)),
    )
  }

  // 5. Execute all D1 writes in one batch call (minimizes D1 round trips).
  if (statements.length > 0) {
    await db.batch(statements as [typeof statements[0], ...typeof statements])
  }

  // 6. Kill VMs for over-budget or subscription-less orgs. Done after D1
  //    writes so the spend is recorded even if the stop calls fail.
  const killPromises: Promise<unknown>[] = []
  const killSessionIds: string[] = []

  for (const [, entry] of orgDeltas) {
    if (entry.killSessionIds.length === 0) continue
    killSessionIds.push(...entry.killSessionIds)
    for (const su of entry.sessionUpdates) {
      killPromises.push(
        bu.stopBrowser(su.buSessionId).catch(() => {
          // VM might already be stopped
        }),
      )
    }
  }

  // Wait for all stop calls, then delete the session rows
  if (killPromises.length > 0) {
    await Promise.allSettled(killPromises)
  }
  if (killSessionIds.length > 0) {
    await db.delete(schema.cloudSession)
      .where(orm.inArray(schema.cloudSession.id, killSessionIds))
  }
}
