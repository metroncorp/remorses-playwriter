-- Track cumulative proxy spend per org and per-session cost deltas.
-- The cron handler reads proxyCost from Browser Use API each minute,
-- computes the delta via last_proxy_cost_cents, and increments org spend.
-- proxySpendPeriodStart tracks which billing period the spend belongs to;
-- when subscription.currentPeriodStart changes, spend resets to 0.
ALTER TABLE org ADD COLUMN proxy_spend_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE org ADD COLUMN proxy_budget_cents INTEGER NOT NULL DEFAULT 500;
ALTER TABLE org ADD COLUMN proxy_spend_period_start INTEGER;
ALTER TABLE cloud_session ADD COLUMN last_proxy_cost_cents INTEGER NOT NULL DEFAULT 0;
