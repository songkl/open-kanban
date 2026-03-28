#!/bin/bash

# 数据迁移脚本：从旧 Prisma 数据库迁移到新 Go 数据库

OLD_DB="${HOME}/Documents/ai/kanban/prisma/dev.db"
NEW_DB="${1:-kanban.db}"

if [ ! -f "$OLD_DB" ]; then
    echo "错误：找不到旧数据库 $OLD_DB"
    exit 1
fi

echo "旧数据库: $OLD_DB"
echo "新数据库: $NEW_DB"
echo ""

# 导出旧数据到 SQL
TEMP_SQL=$(mktemp)

echo "导出旧数据..."

# Users
sqlite3 "$OLD_DB" << 'EOF'
.mode insert users
SELECT id, nickname, avatar, type, role, createdAt, updatedAt FROM "User";
EOF

# Boards
sqlite3 "$OLD_DB" << 'EOF'
.mode insert boards
SELECT id, name, deleted, createdAt, updatedAt FROM "Board";
EOF

# BoardPermissions
sqlite3 "$OLD_DB" << 'EOF'
.mode insert board_permissions
SELECT id, userId, boardId, access, createdAt, updatedAt FROM "BoardPermission";
EOF

# Columns
sqlite3 "$OLD_DB" << 'EOF'
.mode insert columns
SELECT id, name, status, position, color, boardId as board_id, createdAt, updatedAt FROM "Column";
EOF

# ColumnAgents
sqlite3 "$OLD_DB" << 'EOF'
.mode insert column_agents
SELECT id, columnId as column_id, agentTypes as agent_types, createdAt, updatedAt FROM "ColumnAgent";
EOF

# Tasks
sqlite3 "$OLD_DB" << 'EOF'
.mode insert tasks
SELECT id, title, description, priority, assignee, meta, columnId as column_id, position, published, archived, archivedAt as archived_at, createdAt, updatedAt FROM "Task";
EOF

# Comments
sqlite3 "$OLD_DB" << 'EOF'
.mode insert comments
SELECT id, content, author, taskId as task_id, userId as user_id, createdAt, updatedAt FROM "Comment";
EOF

# Subtasks
sqlite3 "$OLD_DB" << 'EOF'
.mode insert subtasks
SELECT id, title, completed, taskId as task_id, createdAt, updatedAt FROM "Subtask";
EOF

# Tokens
sqlite3 "$OLD_DB" << 'EOF'
.mode insert tokens
SELECT id, name, key, userId as user_id, expiresAt as expires_at, createdAt, updatedAt FROM "Token";
EOF

echo ""
echo "迁移完成！"
echo ""
echo "请按以下步骤操作："
echo "1. 备份新数据库: cp $NEW_DB ${NEW_DB}.backup"
echo "2. 删除新数据库: rm $NEW_DB"
echo "3. 启动服务器初始化新数据库结构: ./server (然后 Ctrl+C 停止)"
echo "4. 运行上面的 INSERT 语句导入数据"
