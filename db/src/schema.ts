// Schema for the Playwriter D1 database.
// Contains BetterAuth core tables for auth (Google social login, device flow),
// the org/member hierarchy, and cloud browser/session tables for Browser Use
// cloud browser management.

import { defineRelations } from 'drizzle-orm'
import * as s from 'drizzle-orm/sqlite-core'
import { ulid } from 'ulid'

// Integer column that stores epoch milliseconds as a plain number.
// Accepts Date objects in toDriver so BetterAuth's internal Date params
// don't crash D1's .bind() which only accepts string | number | null | ArrayBuffer.
export const epochMs = s.customType<{ data: number; driverParam: number }>({
  dataType() {
    return 'integer'
  },
  toDriver(value: unknown): number {
    if (value instanceof Date) return value.getTime()
    return value as number
  },
  fromDriver(value: unknown): number {
    return value as number
  },
})

// ── BetterAuth core tables ──────────────────────────────────────────

export const user = s.sqliteTable('user', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  name: s.text('name').notNull(),
  email: s.text('email').notNull().unique(),
  emailVerified: s.integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: s.text('image'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
})

export const session = s.sqliteTable('session', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  userId: s.text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  token: s.text('token').notNull().unique(),
  expiresAt: epochMs('expires_at').notNull(),
  ipAddress: s.text('ip_address'),
  userAgent: s.text('user_agent'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.index('session_user_id_idx').on(table.userId),
])

export const account = s.sqliteTable('account', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  userId: s.text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accountId: s.text('account_id').notNull(),
  providerId: s.text('provider_id').notNull(),
  accessToken: s.text('access_token'),
  refreshToken: s.text('refresh_token'),
  accessTokenExpiresAt: epochMs('access_token_expires_at'),
  refreshTokenExpiresAt: epochMs('refresh_token_expires_at'),
  scope: s.text('scope'),
  idToken: s.text('id_token'),
  password: s.text('password'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.index('account_user_id_idx').on(table.userId),
])

export const verification = s.sqliteTable('verification', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  identifier: s.text('identifier').notNull(),
  value: s.text('value').notNull(),
  expiresAt: epochMs('expires_at').notNull(),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
})

// ── Device flow (BetterAuth device authorization plugin) ────────────

export const deviceCode = s.sqliteTable('device_code', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  deviceCode: s.text('device_code').notNull().unique(),
  userCode: s.text('user_code').notNull().unique(),
  userId: s.text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: epochMs('expires_at').notNull(),
  status: s.text('status', { enum: ['pending', 'approved', 'denied', 'expired'] }).notNull().default('pending'),
  lastPolledAt: epochMs('last_polled_at'),
  pollingInterval: s.integer('polling_interval', { mode: 'number' }),
  clientId: s.text('client_id'),
  scope: s.text('scope'),
}, (table) => [
  s.index('device_code_user_id_idx').on(table.userId),
])

// ── Org tables ──────────────────────────────────────────────────────

export const org = s.sqliteTable('org', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  name: s.text('name').notNull(),
  /** Stripe customer id, one customer per org, set once on first checkout.
   *  Single source of truth; reused for every checkout/portal call so we never
   *  create duplicate Stripe customers. */
  stripeCustomerId: s.text('stripe_customer_id'),
  /** Cumulative cloud spend in cents (browserCost + proxyCost) across all sessions.
   *  Updated by the scheduled cron handler every minute.
   *  Resets to 0 at the start of each billing period. */
  cloudSpendCents: s.integer('cloud_spend_cents', { mode: 'number' }).notNull().default(0),
  /** Max cloud spend in cents before blocking new sessions and killing active ones.
   *  Default $5 (500 cents). Configurable per org. */
  cloudBudgetCents: s.integer('cloud_budget_cents', { mode: 'number' }).notNull().default(500),
  /** Epoch ms of the billing period that cloudSpendCents belongs to.
   *  When subscription.currentPeriodStart differs from this value, the cron
   *  handler resets cloudSpendCents to 0 and updates this marker. */
  cloudSpendPeriodStart: epochMs('cloud_spend_period_start'),
  /** Epoch ms of the last cloud session creation. Used as a per-org rate
   *  limit to prevent rapid connect/disconnect loops that waste VM costs. */
  lastCloudCreateAt: epochMs('last_cloud_create_at'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
})

export const orgMember = s.sqliteTable('org_member', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  orgId: s.text('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  userId: s.text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  role: s.text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.index('org_member_org_id_idx').on(table.orgId),
  s.index('org_member_user_id_idx').on(table.userId),
  s.uniqueIndex('org_member_org_id_user_id_unique').on(table.orgId, table.userId),
  // Ensures ensureOrg() race safety: two concurrent requests for the same user
  // can't both succeed in creating different orgs because the second insert
  // hits this unique constraint.
  s.uniqueIndex('org_member_user_id_unique').on(table.userId),
])

// ── Subscriptions (Stripe) ───────────────────────────────────────────
// One active subscription per org. The subscription's line item quantity
// determines the max concurrent cloud browser sessions the org can run.
// Upserted idempotently by the Stripe webhook on subscription events.

export const subscription = s.sqliteTable('subscription', {
  /** Stripe subscription ID (sub_xxx) */
  subscriptionId: s.text('subscription_id').primaryKey().notNull(),
  orgId: s.text('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  /** Stripe customer ID (cus_xxx) — denormalized from org for webhook resolution */
  customerId: s.text('customer_id'),
  /** Stripe price ID (price_xxx) */
  priceId: s.text('price_id'),
  /** Stripe product ID (prod_xxx) */
  productId: s.text('product_id'),
  /** active, trialing, past_due, canceled, incomplete, incomplete_expired, paused, unpaid */
  status: s.text('status').notNull(),
  /** Subscription quantity — determines max concurrent cloud sessions */
  quantity: s.integer('quantity', { mode: 'number' }).notNull().default(1),
  /** Human-readable plan name (e.g. "Pro Monthly") */
  planName: s.text('plan_name'),
  /** Current billing period start (epoch ms) */
  currentPeriodStart: epochMs('current_period_start'),
  /** Current billing period end (epoch ms) */
  currentPeriodEnd: epochMs('current_period_end'),
  /** Whether subscription auto-cancels at period end */
  cancelAtPeriodEnd: s.integer('cancel_at_period_end', { mode: 'boolean' }).notNull().default(false),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.index('subscription_org_id_idx').on(table.orgId),
])

// ── Cloud sessions (active Browser Use VMs owned by an org) ─────────
// Each row maps an org to an active Browser Use browser VM.
// VM status, cdpUrl, cost, etc. are queried from Browser Use API on
// demand (source of truth) — not duplicated here.
// Row exists while a BU VM is associated with an org; deleted when
// the VM is stopped or discovered dead.

export const cloudSession = s.sqliteTable('cloud_session', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  orgId: s.text('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  /** Concurrent subscription slot claimed by this session. Unique per org. */
  slotIndex: s.integer('slot_index', { mode: 'number' }).notNull(),
  /** Browser Use browser session UUID — used to call getBrowser/stopBrowser */
  browserUseSessionId: s.text('browser_use_session_id').notNull(),
  /** Last known total cost in cents (browserCost + proxyCost) from Browser Use API.
   *  Used by the cron handler to compute the delta since last check,
   *  so we only increment org.cloudSpendCents by the new spend. */
  lastTotalCostCents: s.integer('last_total_cost_cents', { mode: 'number' }).notNull().default(0),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.index('cloud_session_org_id_idx').on(table.orgId),
  s.uniqueIndex('cloud_session_org_id_slot_index_unique').on(table.orgId, table.slotIndex),
])

// ── API Keys (BetterAuth @better-auth/api-key plugin) ───────────────
// Stores hashed API keys for programmatic access (CI, VPS, headless).
// enableSessionForAPIKeys mocks a session from the x-api-key header,
// so all existing requireSession/requireOrgSession calls work transparently.

export const apikey = s.sqliteTable('apikey', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  configId: s.text('config_id').notNull().default('default'),
  name: s.text('name'),
  /** First few characters of the key (includes prefix), shown in UI for identification */
  start: s.text('start'),
  prefix: s.text('prefix'),
  /** The hashed API key. Raw key is only returned at creation time. */
  key: s.text('key').notNull(),
  /** Owner user ID (references: "user" config) */
  referenceId: s.text('reference_id').notNull(),
  refillInterval: s.integer('refill_interval', { mode: 'number' }),
  refillAmount: s.integer('refill_amount', { mode: 'number' }),
  lastRefillAt: epochMs('last_refill_at'),
  enabled: s.integer('enabled', { mode: 'boolean' }).default(true),
  rateLimitEnabled: s.integer('rate_limit_enabled', { mode: 'boolean' }),
  rateLimitTimeWindow: s.integer('rate_limit_time_window', { mode: 'number' }),
  rateLimitMax: s.integer('rate_limit_max', { mode: 'number' }),
  requestCount: s.integer('request_count', { mode: 'number' }),
  remaining: s.integer('remaining', { mode: 'number' }),
  lastRequest: epochMs('last_request'),
  expiresAt: epochMs('expires_at'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
  permissions: s.text('permissions'),
  metadata: s.text('metadata'),
}, (table) => [
  s.index('apikey_reference_id_idx').on(table.referenceId),
  s.index('apikey_config_id_idx').on(table.configId),
  s.index('apikey_key_idx').on(table.key),
])

// ── Relations (v2 API) ──────────────────────────────────────────────

export const relations = defineRelations(
  { user, session, account, verification, deviceCode, org, orgMember, subscription, cloudSession, apikey },
  (r) => ({
    user: {
      sessions: r.many.session(),
      accounts: r.many.account(),
      apikeys: r.many.apikey(),
      orgs: r.many.org({
        from: r.user.id.through(r.orgMember.userId),
        to: r.org.id.through(r.orgMember.orgId),
      }),
    },
    session: {
      user: r.one.user({ from: r.session.userId, to: r.user.id }),
    },
    account: {
      user: r.one.user({ from: r.account.userId, to: r.user.id }),
    },
    verification: {},
    deviceCode: {
      user: r.one.user({ from: r.deviceCode.userId, to: r.user.id }),
    },
    org: {
      members: r.many.orgMember(),
      subscriptions: r.many.subscription(),
      cloudSessions: r.many.cloudSession(),
      users: r.many.user({
        from: r.org.id.through(r.orgMember.orgId),
        to: r.user.id.through(r.orgMember.userId),
      }),
    },
    orgMember: {
      org: r.one.org({ from: r.orgMember.orgId, to: r.org.id }),
      user: r.one.user({ from: r.orgMember.userId, to: r.user.id }),
    },
    subscription: {
      org: r.one.org({ from: r.subscription.orgId, to: r.org.id }),
    },
    cloudSession: {
      org: r.one.org({ from: r.cloudSession.orgId, to: r.org.id }),
    },
    apikey: {
      user: r.one.user({ from: r.apikey.referenceId, to: r.user.id }),
    },
  }),
)
