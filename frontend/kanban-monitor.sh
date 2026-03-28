#!/bin/bash
# Kanban Board Monitor
# Usage: ./kanban-monitor.sh
# Requires: KANBAN_MCP_TOKEN environment variable

BOARD_ID="cmn7p924z0002ztu6pmsdoivr"
TODO_COLUMN="cmn7p924z0003ztu6a2itnrla"
IN_PROGRESS_COLUMN="cmn7p924z0004ztu6y4b9f4xs"
TESTING_COLUMN="cmn7p924z0005ztu6yys75rnp"

echo "=== Kanban Monitor $(date) ==="
echo "Checking board: $BOARD_ID"
echo ""

# List tasks in todo column
echo "Tasks in TODO:"
tasks=$(curl -s -H "Authorization: Bearer $KANBAN_MCP_TOKEN" \
  "http://localhost:8080/api/tasks?columnId=$TODO_COLUMN" | jq -r '.[].id + " - " + .title')

if [ -z "$tasks" ]; then
  echo "  No tasks in TODO"
else
  echo "$tasks" | while read line; do
    echo "  - $line"
  done
fi

echo ""
echo "To move a task to in_progress:"
echo "  curl -X PUT -H 'Authorization: Bearer \$KANBAN_MCP_TOKEN' \\
  'http://localhost:8080/api/tasks/{task_id}' \\
  -d '{\"columnId\": \"$IN_PROGRESS_COLUMN\"}'"

echo ""
echo "To move a task to testing:"
echo "  curl -X PUT -H 'Authorization: Bearer \$KANBAN_MCP_TOKEN' \\
  'http://localhost:8080/api/tasks/{task_id}' \\
  -d '{\"columnId\": \"$TESTING_COLUMN\"}'"
