-- Seed board_permissions.owner_agent_id for existing boards so the
-- owner-aware permission checks (see permission_helper.go:
-- IsBoardOwner / loadBoardAccess owner short-circuit) treat a real
-- human as the owner instead of falling through to "no owner".
--
-- The boards table does NOT have a created_by column today, so we
-- pick the owner from board_permissions itself: the earliest
-- ADMIN row (or, failing that, the earliest permission row) on a
-- given board is almost always the user that the board was created
-- for or by — same as how the CreateBoard handler will stamp
-- new boards going forward.
--
-- Idempotent: rows whose owner_agent_id is already non-NULL are
-- skipped by the WHERE clause. The nested SELECT … FROM (SELECT
-- … LIMIT 1) wrapping dodges MySQL's "Can't specify target table
-- for update in FROM clause" guard.

-- Step 1: stamp the earliest ADMIN row per board.
UPDATE board_permissions
SET owner_agent_id = (
    SELECT user_id FROM (
        SELECT bp2.user_id
        FROM board_permissions bp2
        WHERE bp2.board_id = board_permissions.board_id
          AND bp2.access = 'ADMIN'
        ORDER BY bp2.created_at ASC, bp2.id ASC
        LIMIT 1
    ) AS earliest_admin
)
WHERE owner_agent_id IS NULL
  AND EXISTS (
      SELECT 1 FROM board_permissions bp3
      WHERE bp3.board_id = board_permissions.board_id
        AND bp3.access = 'ADMIN'
  );

-- Step 2: boards with no ADMIN row at all (rare — should only
-- happen for boards that pre-date the permission system) get the
-- earliest permission row of any level as a best-effort owner.
UPDATE board_permissions
SET owner_agent_id = (
    SELECT user_id FROM (
        SELECT bp2.user_id
        FROM board_permissions bp2
        WHERE bp2.board_id = board_permissions.board_id
        ORDER BY bp2.created_at ASC, bp2.id ASC
        LIMIT 1
    ) AS earliest_any
)
WHERE owner_agent_id IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM board_permissions bp3
      WHERE bp3.board_id = board_permissions.board_id
        AND bp3.access = 'ADMIN'
  )
  AND EXISTS (
      SELECT 1 FROM board_permissions bp3
      WHERE bp3.board_id = board_permissions.board_id
  );