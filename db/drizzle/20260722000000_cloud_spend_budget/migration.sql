-- Rename proxy-only budget to total cloud spend (browserCost + proxyCost).
-- Add per-org creation rate limit timestamp.
-- Rename per-session proxy cost baseline to total cost baseline.

-- org: rename proxy columns to cloud, add rate limit column
ALTER TABLE org ADD COLUMN cloud_spend_cents INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE org ADD COLUMN cloud_budget_cents INTEGER NOT NULL DEFAULT 500;
--> statement-breakpoint
ALTER TABLE org ADD COLUMN cloud_spend_period_start INTEGER;
--> statement-breakpoint
ALTER TABLE org ADD COLUMN last_cloud_create_at INTEGER;
--> statement-breakpoint
-- Migrate existing proxy spend data to new cloud columns
UPDATE org SET cloud_spend_cents = proxy_spend_cents, cloud_budget_cents = proxy_budget_cents, cloud_spend_period_start = proxy_spend_period_start;
--> statement-breakpoint
-- cloud_session: rename last_proxy_cost_cents to last_total_cost_cents
ALTER TABLE cloud_session ADD COLUMN last_total_cost_cents INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE cloud_session SET last_total_cost_cents = last_proxy_cost_cents;
