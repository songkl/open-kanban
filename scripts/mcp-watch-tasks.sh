#!/bin/bash
# 循环监控指定看板指定列的任务

usage() {
  echo "Usage: $0 -b <boardId> -c <columnId> [-i <interval>]"
  echo "  boardId:   看板ID"
  echo "  columnId:  列ID"
  echo "  interval:  间隔秒数 (默认30)"
  exit 1
}

BOARD_ID=""
COLUMN_ID=""
INTERVAL=30

while getopts "b:c:i:h" opt; do
  case $opt in
    b) BOARD_ID="$OPTARG" ;;
    c) COLUMN_ID="$OPTARG" ;;
    i) INTERVAL="$OPTARG" ;;
    h) usage ;;
    *) usage ;;
  esac
done

[ -z "$BOARD_ID" ] || [ -z "$COLUMN_ID" ] && usage

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCP_CALL="$SCRIPT_DIR/mcp-call.js"

if [ ! -f "$MCP_CALL" ]; then
  echo "Error: mcp-call.js not found in $SCRIPT_DIR"
  exit 1
fi

while true; do
  clear
  echo "=========================================="
  echo "  监控任务"
  echo "  Board: $BOARD_ID"
  echo "  Column: $COLUMN_ID"
  echo "  $(date '+%Y-%m-%d %H:%M:%S')"
  echo "=========================================="
  echo ""
  
  RESULT=$(node "$MCP_CALL" list_tasks '{"boardId":"'"$BOARD_ID"'","columnId":"'"$COLUMN_ID"'"}' 2>/dev/null)
  
  TASK_IDS=$(echo "$RESULT" | grep -E '^\s+"id":' | sed 's/.*"id": *"\([^"]*\)".*/\1/' | grep 'T-' | head -20)
  
  COUNT=$(echo "$TASK_IDS" | grep -c . 2>/dev/null || echo 0)
  
  if [ -n "$TASK_IDS" ] && [ "$COUNT" -gt 0 ]; then
    echo "▶ 找到 $COUNT 个任务:"
    echo ""
    echo "$TASK_IDS" | while read -r id; do
      [ -n "$id" ] && echo "   📋 $id"
    done
    echo ""
    echo "等待 ${INTERVAL} 秒后再次检查..."
  else
    echo "⏳ 当前没有任务，${INTERVAL} 秒后重试..."
  fi
  
  sleep "$INTERVAL"
done
