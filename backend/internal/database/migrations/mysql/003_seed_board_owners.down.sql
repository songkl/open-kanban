-- Reverse of 003_seed_board_owners.up.sql: clear the owner_agent_id
-- back to NULL on every board_permissions row. The down migration
-- is intentionally total — running it then re-running the up
-- migration should produce the same final state (the same owners
-- get re-seeded from board_permissions history).
--
-- No data loss beyond the owner stamp; access rows themselves are
-- untouched. A future handler can re-run the up migration to
-- restore the owner state.

UPDATE board_permissions SET owner_agent_id = NULL;