package repositories_test

import (
	"database/sql"
	"fmt"
	_ "github.com/mattn/go-sqlite3"
	"testing"
)

func TestDebugRepository(t *testing.T) {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}

	schema := `
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, nickname TEXT NOT NULL, password TEXT, avatar TEXT, type TEXT DEFAULT 'HUMAN', role TEXT DEFAULT 'MEMBER', enabled BOOLEAN DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_active_at DATETIME);
    CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, short_alias TEXT UNIQUE, task_counter INTEGER DEFAULT 1000, deleted BOOLEAN DEFAULT 0, is_public BOOLEAN DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, description TEXT DEFAULT '');
    CREATE TABLE columns (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT, position INTEGER DEFAULT 0, color TEXT DEFAULT '#6b7280', description TEXT DEFAULT '', board_id TEXT NOT NULL, owner_agent_id TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, priority TEXT DEFAULT 'medium', assignee TEXT, meta TEXT, column_id TEXT NOT NULL, position INTEGER DEFAULT 0, published BOOLEAN DEFAULT 0, archived BOOLEAN DEFAULT 0, archived_at DATETIME, due_at DATETIME, agent_id TEXT, agent_prompt TEXT, created_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE);
    `

	_, _ = db.Exec(schema)
	_, _ = db.Exec(`INSERT INTO boards (id, name, short_alias, task_counter) VALUES ('b1', 'Test Board', 'TST', 1000)`)
	_, _ = db.Exec(`INSERT INTO columns (id, name, board_id, position, status) VALUES ('c1', 'Todo', 'b1', 0, 'todo')`)
	db.Exec(`INSERT INTO columns (id, name, board_id, position, status) VALUES ('c2', 'Done', 'b1', 1, 'done')`)
	db.Exec(`INSERT INTO tasks (id, title, column_id, position, published) VALUES ('t1', 'Task 1', 'c1', 100, 1)`)
	db.Exec(`INSERT INTO tasks (id, title, column_id, position, published) VALUES ('t2', 'Task 2', 'c1', 200, 1)`)

	// Test: simple SELECT
	var count int
	_ = db.QueryRow("SELECT COUNT(*) FROM tasks").Scan(&count)
	fmt.Printf("Simple tasks count: %d\n", count)

	// Test: JOIN columns
	_ = db.QueryRow("SELECT COUNT(*) FROM tasks t JOIN columns col ON t.column_id = col.id").Scan(&count)
	fmt.Printf("Tasks JOIN columns count: %d\n", count)

	// Test: the full query
	rows, err := db.Query(`SELECT t.id, t.title, t.description, t.priority, t.assignee, t.meta, t.column_id, t.position,
          t.published, t.archived, t.archived_at, t.due_at, t.agent_id, t.agent_prompt, t.created_by, t.created_at, t.updated_at,
          COALESCE(cc.cnt, 0) as comment_count,
          COALESCE(sc.cnt, 0) as subtask_count,
          COALESCE(u.nickname, u.username) as created_by_username,
          u.nickname as created_by_nickname,
          COALESCE(u.avatar, '') as created_by_avatar
          FROM tasks t
          JOIN columns col ON t.column_id = col.id
          LEFT JOIN (SELECT task_id, COUNT(*) as cnt FROM comments GROUP BY task_id) cc ON t.id = cc.task_id
          LEFT JOIN (SELECT task_id, COUNT(*) as cnt FROM subtasks GROUP BY task_id) sc ON t.id = sc.task_id
          LEFT JOIN users u ON t.created_by = u.id
          WHERE t.column_id IN (?) AND t.published = 1 AND t.archived = 0
          ORDER BY col.position ASC, t.position ASC
          LIMIT 10 OFFSET 0`, "c1")
	if err != nil {
		fmt.Printf("Query error: %v\n", err)
		return
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		n++
	}
	fmt.Printf("Full query result count: %d\n", n)
}
