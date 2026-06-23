// Cloud browser API routes mounted at /api/cloud/*.
// Proxies Browser Use API v3 — the bu_ API key never reaches the client.
// VM status is queried from Browser Use on demand (source of truth),
// our D1 only stores the org → BU session ID mapping for multi-tenancy.

import { env } from 'cloudflare:workers'
import { Spiceflow, json } from 'spiceflow'
import { z } from 'zod'
import * as orm from 'drizzle-orm'
import * as schema from 'db/schema'
import { getDb, requireOrgSession } from './db.ts'
import { BrowserUseClient } from './lib/browser-use.ts'
import type { BrowserSession } from './lib/browser-use.ts'
import { ACTIVE_SUBSCRIPTION_STATUSES } from './lib/billing-rules.ts'

function getBrowserUse() {
  return new BrowserUseClient({ apiKey: env.BROWSER_USE_API_KEY as string })
}

// ── Types ───────────────────────────────────────────────────────────

interface CloudSessionStatus {
  cloudSessionId: string
  browserUseSessionId: string
  /** Display index derived from creation order (1-based) */
  index: number
  createdAt: number
  status: 'active' | 'stopped'
  cdpUrl: string | null
  liveUrl: string | null
  timeoutAt: string
}

// ── Helpers ─────────────────────────────────────────────────────────

const PENDING_PREFIX = 'pending-'
// Placeholder rows older than 2 minutes are considered stale (VM creation
// should complete in under 60s). Fresh ones are counted as occupied slots.
const PENDING_STALE_MS = 2 * 60_000

function isPendingRow(row: typeof schema.cloudSession.$inferSelect): boolean {
  return row.browserUseSessionId.startsWith(PENDING_PREFIX)
}

function isUniqueConstraintError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.includes('UNIQUE constraint failed') || message.includes('SQLITE_CONSTRAINT_UNIQUE')
}

async function claimCloudSessionSlot({
  orgId,
  maxSessions,
}: {
  orgId: string
  maxSessions: number
}): Promise<typeof schema.cloudSession.$inferSelect | null> {
  const db = getDb()
  for (let slotIndex = 1; slotIndex <= maxSessions; slotIndex++) {
    const placeholderId = `${PENDING_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    try {
      const [row] = await db
        .insert(schema.cloudSession)
        .values({
          orgId,
          slotIndex,
          browserUseSessionId: placeholderId,
        })
        .returning()
      if (row) return row
    } catch (cause) {
      if (isUniqueConstraintError(cause)) {
        continue
      }
      throw new Error('Failed to claim cloud session slot', { cause })
    }
  }
  return null
}

/** Check if a cloud session row represents an occupied slot.
 *  Returns true if occupied. Does NOT delete stale/dead rows itself;
 *  instead pushes their IDs into deadIds for the caller to batch-delete. */
function checkSlotOccupied(
  row: typeof schema.cloudSession.$inferSelect,
  deadIds: string[],
): 'occupied' | 'dead' | 'needs-api-check' {
  if (isPendingRow(row)) {
    if (Date.now() - row.createdAt < PENDING_STALE_MS) {
      return 'occupied'
    }
    deadIds.push(row.id)
    return 'dead'
  }
  return 'needs-api-check'
}

/** Check if a cloud session's BU VM is still alive. Returns null if dead
 *  and pushes the row ID into deadIds for the caller to batch-delete. */
async function resolveActiveSession(
  row: typeof schema.cloudSession.$inferSelect,
  bu: BrowserUseClient,
  deadIds: string[],
): Promise<BrowserSession | null> {
  try {
    const vm = await bu.getBrowser(row.browserUseSessionId)
    if (vm.status === 'active') {
      return vm
    }
  } catch {
    // BU returned 404 or error, VM is gone
  }
  deadIds.push(row.id)
  return null
}

/** Delete dead cloud session rows in one statement. Idempotent: concurrent
 *  requests deleting the same row is safe (DELETE by PK is a no-op if gone). */
async function cleanupDeadSessions(deadIds: string[]): Promise<void> {
  if (deadIds.length === 0) return
  const db = getDb()
  const uniqueIds = [...new Set(deadIds)]
  await db.delete(schema.cloudSession).where(orm.inArray(schema.cloudSession.id, uniqueIds))
}

// ── Sub-app ─────────────────────────────────────────────────────────

export const cloudApp = new Spiceflow({ basePath: '/api/cloud' })

  // ── GET /api/cloud/status ───────────────────────────────────────
  // Returns org's active cloud sessions with their VM status.
  .get('/status', async ({ request }) => {
    const { org } = await requireOrgSession(request)
    const db = getDb()
    const bu = getBrowserUse()

    const sessions = await db.query.cloudSession.findMany({
      where: { orgId: org.id },
      orderBy: { createdAt: 'asc' },
    })

    // Check each session against BU API in parallel, collecting dead IDs
    // for a single batch-delete at the end instead of N individual deletes.
    const deadIds: string[] = []
    const nonPending = sessions.filter((row) => {
      return !isPendingRow(row)
    })
    const vmResults = await Promise.all(
      nonPending.map((row) => {
        return resolveActiveSession(row, bu, deadIds)
      }),
    )

    const result: CloudSessionStatus[] = []
    for (let i = 0; i < nonPending.length; i++) {
      const row = nonPending[i]!
      const vm = vmResults[i]
      if (vm) {
        result.push({
          cloudSessionId: row.id,
          browserUseSessionId: row.browserUseSessionId,
          index: result.length + 1,
          createdAt: row.createdAt,
          status: vm.status,
          cdpUrl: vm.cdpUrl,
          liveUrl: vm.liveUrl,
          timeoutAt: vm.timeoutAt,
        })
      }
    }

    // Batch-delete all dead/stale sessions in one D1 call
    await cleanupDeadSessions(deadIds)

    return { sessions: result }
  })

  // ── POST /api/cloud/connect ─────────────────────────────────────
  // Create a new Browser Use VM for the org.
  // Returns the cdpUrl for direct CDP connection.
  .route({
    method: 'POST',
    path: '/connect',
    request: z.object({
      proxyRegion: z.string().optional(),
      /** Cloud browser timeout in minutes (1-240, default 60) */
      timeout: z.number().min(1).max(240).optional(),
      customProxy: z
        .object({
          host: z.string(),
          port: z.number(),
          username: z.string().optional(),
          password: z.string().optional(),
        })
        .optional(),
    }),
    async handler({ request }) {
      const { org } = await requireOrgSession(request)
      const body = await request.json()
      const db = getDb()
      const bu = getBrowserUse()

      // Batch-read subscription + cloud sessions + org budget in one D1 round-trip.
      const [activeSub, dbSessions, orgRow] = await db.batch([
        db.query.subscription.findFirst({
          where: {
            orgId: org.id,
            status: { in: [...ACTIVE_SUBSCRIPTION_STATUSES] },
          },
        }),
        db.query.cloudSession.findMany({
          where: { orgId: org.id },
        }),
        db.query.org.findFirst({
          where: { id: org.id },
          columns: { proxySpendCents: true, proxyBudgetCents: true, proxySpendPeriodStart: true },
        }),
      ] as const)
      if (!activeSub) {
        throw json(
          { error: 'No active subscription. Run `playwriter cloud subscribe` to get started.' },
          { status: 403 },
        )
      }

      // Detect billing period rollover and reset spend if needed.
      // This also handles the case where all sessions were killed by the cron
      // (no active sessions = cron returns early = period never resets).
      // Without this, the org would be permanently blocked after a period ends.
      const periodRolledOver = activeSub.currentPeriodStart != null
        && orgRow?.proxySpendPeriodStart !== activeSub.currentPeriodStart
      let proxySpendCents = orgRow?.proxySpendCents ?? 0
      if (periodRolledOver) {
        proxySpendCents = 0
        await db.update(schema.org)
          .set({
            proxySpendCents: 0,
            proxySpendPeriodStart: activeSub.currentPeriodStart,
            updatedAt: Date.now(),
          })
          .where(orm.eq(schema.org.id, org.id))
      }

      // Block new sessions if org exceeded their proxy spend budget
      if (orgRow && proxySpendCents >= orgRow.proxyBudgetCents) {
        const spentDollars = (proxySpendCents / 100).toFixed(2)
        const budgetDollars = (orgRow.proxyBudgetCents / 100).toFixed(2)
        throw json(
          { error: `Proxy usage budget exceeded ($${spentDollars}/$${budgetDollars}). Contact support to increase your budget.` },
          { status: 403 },
        )
      }

      const maxSessions = activeSub.quantity
      // Check each session, collecting dead IDs for batch cleanup.
      // BU API checks run in parallel; stale pending rows are detected locally.
      const deadIds: string[] = []
      let freshPendingCount = 0
      const buCheckRows: typeof dbSessions = []
      for (const row of dbSessions) {
        const status = checkSlotOccupied(row, deadIds)
        if (status === 'occupied') {
          freshPendingCount++
        } else if (status === 'needs-api-check') {
          buCheckRows.push(row)
        }
      }
      const buResults = await Promise.all(
        buCheckRows.map((row) => {
          return resolveActiveSession(row, bu, deadIds)
        }),
      )
      await cleanupDeadSessions(deadIds)
      const buOccupied = buResults.filter(Boolean).length
      const activeCount = freshPendingCount + buOccupied

      if (activeCount >= maxSessions) {
        throw json(
          {
            error: `Cloud session limit reached (${activeCount}/${maxSessions}). Stop an existing session or upgrade your subscription quantity.`,
          },
          { status: 403 },
        )
      }

      // Claim a quota slot before creating the paid VM. The unique index on
      // (orgId, slotIndex) makes this atomic under concurrent requests: only
      // one request can own each subscription slot.
      const cloudSession = await claimCloudSessionSlot({ orgId: org.id, maxSessions })
      if (!cloudSession) {
        throw json(
          { error: `Cloud session limit reached. Stop an existing session or upgrade your subscription quantity.` },
          { status: 403 },
        )
      }

      // Now create the BU VM. If this fails, clean up the placeholder row.
      let vm: BrowserSession
      try {
        vm = await bu.createBrowser({
          // Proxy disabled by default to save cost. Pass --proxy <region> to enable.
          proxyCountryCode: body.proxyRegion ?? null,
          timeout: body.timeout ?? 60,
          customProxy: body.customProxy,
        })
      } catch (cause) {
        await db
          .delete(schema.cloudSession)
          .where(orm.eq(schema.cloudSession.id, cloudSession.id))
          .limit(1)
          .catch(() => {})
        throw new Error('Failed to create cloud browser', { cause })
      }

      if (!vm.cdpUrl) {
        // No CDP URL means the VM failed to start. Clean up both.
        await bu.stopBrowser(vm.id).catch(() => {})
        await db
          .delete(schema.cloudSession)
          .where(orm.eq(schema.cloudSession.id, cloudSession.id))
          .limit(1)
          .catch(() => {})
        throw json(
          { error: 'Browser Use returned no CDP URL. The VM may have failed to start.' },
          { status: 502 },
        )
      }

      // Update the placeholder with the real BU session ID.
      // Verify the row still exists (wasn't deleted by a concurrent stale cleanup).
      const updateResult = await db
        .update(schema.cloudSession)
        .set({ browserUseSessionId: vm.id })
        .where(orm.eq(schema.cloudSession.id, cloudSession.id))
        .limit(1)
        .returning()

      if (!updateResult.length) {
        // Our placeholder was deleted (e.g. by a concurrent stale cleanup).
        // Stop the VM since our slot is gone.
        await bu.stopBrowser(vm.id).catch(() => {})
        throw new Error('Cloud session slot was reclaimed during VM creation')
      }

      return {
        cloudSessionId: cloudSession.id,
        cdpUrl: vm.cdpUrl,
        liveUrl: vm.liveUrl,
        timeoutAt: vm.timeoutAt,
      }
    },
  })

  // ── POST /api/cloud/disconnect ──────────────────────────────────
  // Stop a cloud browser VM.
  .route({
    method: 'POST',
    path: '/disconnect',
    request: z.object({
      cloudSessionId: z.string(),
    }),
    async handler({ request }) {
      const { org } = await requireOrgSession(request)
      const body = await request.json()
      const db = getDb()
      const bu = getBrowserUse()

      // Find the session and verify org ownership directly
      const cloudSession = await db.query.cloudSession.findFirst({
        where: { id: body.cloudSessionId, orgId: org.id },
      })
      if (!cloudSession) {
        throw json({ error: 'cloud session not found' }, { status: 404 })
      }

      // Stop the BU VM
      try {
        await bu.stopBrowser(cloudSession.browserUseSessionId)
      } catch {
        // VM might already be stopped
      }

      // Remove the mapping row
      await db
        .delete(schema.cloudSession)
        .where(orm.eq(schema.cloudSession.id, cloudSession.id))
        .limit(1)

      return { ok: true }
    },
  })
