#!/bin/bash
usage() {
  echo "Usage: $0 -b <boardId> -s <status>"
  echo "  boardId: kanban ID"
  echo "  status:  todo | in_progress | review | done"
  exit 1
}

BOARD_ID=""
STATUS=""

while getopts "b:s:h" opt; do
  case $opt in
    b) BOARD_ID="$OPTARG" ;;
    s) STATUS="$OPTARG" ;;
    h) usage ;;
    *) usage ;;
  esac
done

[ -z "$BOARD_ID" ] || [ -z "$STATUS" ] && usage

API_URL="${KANBAN_API_URL:-http://localhost:8080}"

STATUS_MAP='{"todo":"待办","in_progress":"进行中","review":"待审核","done":"已完成"}'

COLUMN_NAME=$(echo "$STATUS_MAP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('$STATUS',''))")

[ -z "$COLUMN_NAME" ] && echo "Error: Invalid status" && exit 1

COLUMNS=$(curl -s "$API_URL/api/columns?boardId=$BOARD_ID" -H "X-MCP-Request: true")

COUNT=$(echo "$COLUMNS" | python3 -c "
import json,sys
data = json.load(sys.stdin)
for col in data:
    if col.get('name') == '$COLUMN_NAME':
        print(len(col.get('tasks', [])))
        break
else:
    print(0)
" 2>/dev/null)

echo "Board: $BOARD_ID"
echo "Status: $STATUS ($COLUMN_NAME)"
echo "Tasks count: ${COUNT:-0}"
