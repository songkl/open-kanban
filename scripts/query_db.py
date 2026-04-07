#!/usr/bin/env python3
import sqlite3
import os

db_path = 'backend/kanban.db'
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Get columns
cursor.execute('SELECT id, name FROM columns')
columns = cursor.fetchall()
print('Columns:')
for c in columns:
    print(f'  {c[0]}: {c[1]}')

# Find todo column
todo_col = [c for c in columns if c[1] == '待办']
if todo_col:
    todo_id = todo_col[0][0]
    print(f'\nTodo column ID: {todo_id}')

    # Get todo tasks
    cursor.execute('''
        SELECT id, title, priority, created_at
        FROM tasks
        WHERE column_id = ? AND archived = 0
        ORDER BY
            CASE priority
                WHEN 'high' THEN 0
                WHEN 'medium' THEN 1
                WHEN 'low' THEN 2
            END,
            created_at ASC
    ''', (todo_id,))
    tasks = cursor.fetchall()
    print(f'\nTodo tasks ({len(tasks)}):')
    for t in tasks:
        print(f'  [{t[2]}] {t[1]} (ID: {t[0]})')

conn.close()
