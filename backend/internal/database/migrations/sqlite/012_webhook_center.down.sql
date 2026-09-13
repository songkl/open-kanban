-- Reverse of 012_webhook_center.up.sql. Drops the indexes first
-- (so the FK on webhook_deliveries.webhook_id isn't pinned by
-- idx_webhook_deliveries_webhook_started), then the dependent
-- table webhook_deliveries, then the parent table webhooks.
--
-- Lossy: every historical delivery row is lost on rollback. The
-- existing activities table is the durable audit trail for
-- events that need permanence; this migration only owns the
-- per-webhook delivery log used by the management UI (§7.3).

DROP INDEX IF EXISTS idx_webhook_deliveries_status_next_retry;
DROP INDEX IF EXISTS idx_webhook_deliveries_webhook_started;
DROP TABLE IF EXISTS webhook_deliveries;
DROP TABLE IF EXISTS webhooks;
