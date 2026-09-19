-- 005_relax_task_runs_runner_id.up.sql (MySQL)
--
-- Drop the foreign-key constraint from task_runs.runner_id to
-- users.id. The runner identifier sent over the wire
-- (ClaimRunRequest.RunnerID) is a stable per-process string of the
-- form "hostname-pid-uuid" the CLI generates at startup; it is not
-- the same as a users.id primary key. The original FK forced every
-- claim to store user.ID in runner_id, which in turn made the
-- heartbeat + finish round-trips reject every CLI request that
-- compared against the wire-format runnerId — i.e. the bug only
-- stayed invisible because the handler-level tests owned every
-- runnerId string. Removing the FK keeps the column NOT NULL (we
-- still need a non-empty value to identify the holder) but lets it
-- accept any opaque token, which matches what the CLI sends.
--
-- MySQL supports ALTER TABLE … DROP FOREIGN KEY, so we can relax
-- the schema in place without rebuilding the table.

ALTER TABLE task_runs DROP FOREIGN KEY task_runs_ibfk_2;
