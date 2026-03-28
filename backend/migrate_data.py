#!/usr/bin/env python3
"""
数据迁移脚本：从旧 Prisma 数据库迁移到新 Go 数据库
"""

import sqlite3
import os
import shutil
from pathlib import Path

OLD_DB = Path.home() / "Documents/ai/kanban/prisma/dev.db"
NEW_DB = Path("kanban.db")

def migrate():
    if not OLD_DB.exists():
        print(f"错误：找不到旧数据库 {OLD_DB}")
        return False

    # 备份新数据库
    if NEW_DB.exists():
        backup = Path(f"{NEW_DB}.backup")
        shutil.copy(NEW_DB, backup)
        print(f"已备份新数据库到: {backup}")
        os.remove(NEW_DB)
        print(f"已删除旧的新数据库")

    # 连接旧数据库
    old_conn = sqlite3.connect(OLD_DB)
    old_conn.row_factory = sqlite3.Row
    old_cur = old_conn.cursor()

    print(f"\n正在从 {OLD_DB} 读取数据...")

    # 读取所有数据
    users = old_cur.execute('SELECT * FROM "User"').fetchall()
    boards = old_cur.execute('SELECT * FROM "Board"').fetchall()
    board_permissions = old_cur.execute('SELECT * FROM "BoardPermission"').fetchall()
    columns = old_cur.execute('SELECT * FROM "Column"').fetchall()
    column_agents = old_cur.execute('SELECT * FROM "ColumnAgent"').fetchall()
    tasks = old_cur.execute('SELECT * FROM "Task"').fetchall()
    comments = old_cur.execute('SELECT * FROM "Comment"').fetchall()
    subtasks = old_cur.execute('SELECT * FROM "Subtask"').fetchall()
    tokens = old_cur.execute('SELECT * FROM "Token"').fetchall()

    old_conn.close()

    print(f"读取完成:")
    print(f"  - Users: {len(users)}")
    print(f"  - Boards: {len(boards)}")
    print(f"  - BoardPermissions: {len(board_permissions)}")
    print(f"  - Columns: {len(columns)}")
    print(f"  - ColumnAgents: {len(column_agents)}")
    print(f"  - Tasks: {len(tasks)}")
    print(f"  - Comments: {len(comments)}")
    print(f"  - Subtasks: {len(subtasks)}")
    print(f"  - Tokens: {len(tokens)}")

    # 返回数据供后续使用
    return {
        'users': users,
        'boards': boards,
        'board_permissions': board_permissions,
        'columns': columns,
        'column_agents': column_agents,
        'tasks': tasks,
        'comments': comments,
        'subtasks': subtasks,
        'tokens': tokens,
    }

def insert_data(data):
    """将数据插入新数据库"""

    print(f"\n正在写入新数据库 {NEW_DB}...")

    # 如果数据库不存在，先创建并初始化表结构
    db_exists = NEW_DB.exists()
    new_conn = sqlite3.connect(NEW_DB)
    new_cur = new_conn.cursor()

    if not db_exists:
        print("创建数据库表结构...")
        # 读取并执行迁移 SQL
        migrations_dir = Path(__file__).parent / "migrations" / "sqlite"
        migration_files = sorted(migrations_dir.glob("*.up.sql"))

        for sql_file in migration_files:
            print(f"  执行: {sql_file.name}")
            with open(sql_file, 'r') as f:
                sql = f.read()
            new_cur.executescript(sql)

        new_conn.commit()
        print("  ✓ 表结构创建完成")
    else:
        # 清空现有数据（保留表结构）
        tables = ['subtasks', 'comments', 'tasks', 'column_agents', 'board_permissions',
                  'columns', 'tokens', 'boards', 'users']
        for table in tables:
            new_cur.execute(f"DELETE FROM {table}")
        print("已清空现有数据")

    # 插入 Users
    for row in data['users']:
        new_cur.execute('''
            INSERT INTO users (id, nickname, avatar, type, role, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (row['id'], row['nickname'], row['avatar'], row['type'], row['role'],
              row['createdAt'], row['updatedAt']))
    print(f"  ✓ Users: {len(data['users'])} 条")

    # 插入 Boards
    for row in data['boards']:
        new_cur.execute('''
            INSERT INTO boards (id, name, deleted, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
        ''', (row['id'], row['name'], row['deleted'], row['createdAt'], row['updatedAt']))
    print(f"  ✓ Boards: {len(data['boards'])} 条")

    # 插入 BoardPermissions
    for row in data['board_permissions']:
        new_cur.execute('''
            INSERT INTO board_permissions (id, user_id, board_id, access, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (row['id'], row['userId'], row['boardId'], row['access'],
              row['createdAt'], row['updatedAt']))
    print(f"  ✓ BoardPermissions: {len(data['board_permissions'])} 条")

    # 插入 Columns
    for row in data['columns']:
        new_cur.execute('''
            INSERT INTO columns (id, name, status, position, color, board_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (row['id'], row['name'], row['status'], row['position'], row['color'],
              row['boardId'], row['createdAt'], row['updatedAt']))
    print(f"  ✓ Columns: {len(data['columns'])} 条")

    # 插入 ColumnAgents
    for row in data['column_agents']:
        new_cur.execute('''
            INSERT INTO column_agents (id, column_id, agent_types, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
        ''', (row['id'], row['columnId'], row['agentTypes'], row['createdAt'], row['updatedAt']))
    print(f"  ✓ ColumnAgents: {len(data['column_agents'])} 条")

    # 插入 Tasks
    for row in data['tasks']:
        new_cur.execute('''
            INSERT INTO tasks (id, title, description, priority, assignee, meta, column_id,
                             position, published, archived, archived_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (row['id'], row['title'], row['description'], row['priority'], row['assignee'],
              row['meta'], row['columnId'], row['position'], row['published'], row['archived'],
              row['archivedAt'], row['createdAt'], row['updatedAt']))
    print(f"  ✓ Tasks: {len(data['tasks'])} 条")

    # 插入 Comments
    for row in data['comments']:
        new_cur.execute('''
            INSERT INTO comments (id, content, author, task_id, user_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (row['id'], row['content'], row['author'], row['taskId'], row['userId'],
              row['createdAt'], row['updatedAt']))
    print(f"  ✓ Comments: {len(data['comments'])} 条")

    # 插入 Subtasks
    for row in data['subtasks']:
        new_cur.execute('''
            INSERT INTO subtasks (id, title, completed, task_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (row['id'], row['title'], row['completed'], row['taskId'],
              row['createdAt'], row['updatedAt']))
    print(f"  ✓ Subtasks: {len(data['subtasks'])} 条")

    # 插入 Tokens
    for row in data['tokens']:
        new_cur.execute('''
            INSERT INTO tokens (id, name, key, user_id, expires_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (row['id'], row['name'], row['key'], row['userId'], row['expiresAt'],
              row['createdAt'], row['updatedAt']))
    print(f"  ✓ Tokens: {len(data['tokens'])} 条")

    new_conn.commit()
    new_conn.close()

    print(f"\n✅ 数据迁移完成！新数据库: {NEW_DB}")
    return True

if __name__ == '__main__':
    print("="*60)
    print("看板数据迁移工具")
    print("="*60)

    data = migrate()
    if not data:
        exit(1)

    # 检查新数据库，如果不存在会由 insert_data 创建
    if NEW_DB.exists():
        # 验证新数据库结构
        try:
            conn = sqlite3.connect(NEW_DB)
            cur = conn.cursor()
            cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
            tables = [t[0] for t in cur.fetchall()]
            conn.close()

            required = ['users', 'boards', 'columns', 'tasks']
            if not all(t in tables for t in required):
                print(f"\n警告：新数据库结构不完整，将自动创建")
        except Exception as e:
            print(f"\n错误：无法验证新数据库: {e}")
            exit(1)

    # 执行插入
    if insert_data(data):
        print("\n可以使用新数据库启动服务器了:")
        print("  ./server")
    else:
        exit(1)
