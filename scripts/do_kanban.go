package main

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"sort"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

type Task struct {
	ID          string
	Title       string
	Description sql.NullString
	Priority    string
	ColumnID    string
	ColumnName  string
	CreatedAt   time.Time
}

func main() {
	dbPath := os.Getenv("KANBAN_DB")
	if dbPath == "" {
		dbPath = "backend/kanban.db"
	}

	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	// Step 1: Find the "todo" column (待办)
	var todoColumnID string
	err = db.QueryRow("SELECT id FROM columns WHERE name = '待办'").Scan(&todoColumnID)
	if err != nil {
		log.Fatal("Could not find '待办' column:", err)
	}
	fmt.Println("Found todo column:", todoColumnID)

	// Step 2: Get all todo tasks with priority ordering
	rows, err := db.Query(`
		SELECT t.id, t.title, t.description, t.priority, t.column_id, t.created_at
		FROM tasks t
		WHERE t.column_id = ? AND t.archived = false
		ORDER BY t.created_at ASC
	`, todoColumnID)
	if err != nil {
		log.Fatal(err)
	}
	defer rows.Close()

	var tasks []Task
	for rows.Next() {
		var t Task
		err := rows.Scan(&t.ID, &t.Title, &t.Description, &t.Priority, &t.ColumnID, &t.CreatedAt)
		if err != nil {
			log.Fatal(err)
		}
		tasks = append(tasks, t)
	}

	if len(tasks) == 0 {
		fmt.Println("No todo tasks found.")
		return
	}

	// Step 3: Sort by priority (high > medium > low), then by created_at
	priorityOrder := map[string]int{"high": 0, "medium": 1, "low": 2}
	sort.Slice(tasks, func(i, j int) bool {
		pi := priorityOrder[tasks[i].Priority]
		pj := priorityOrder[tasks[j].Priority]
		if pi != pj {
			return pi < pj
		}
		return tasks[i].CreatedAt.Before(tasks[j].CreatedAt)
	})

	// Print all tasks
	fmt.Println("\n=== Todo Tasks ===")
	for i, t := range tasks {
		marker := ""
		if i == 0 {
			marker = " <-- SELECTED"
		}
		fmt.Printf("[%s] %s (ID: %s)%s\n", t.Priority, t.Title, t.ID, marker)
	}

	// Select the highest priority task
	selected := tasks[0]
	fmt.Printf("\n=== Selected Task ===\n")
	fmt.Printf("ID: %s\n", selected.ID)
	fmt.Printf("Title: %s\n", selected.Title)
	fmt.Printf("Priority: %s\n", selected.Priority)
	if selected.Description.Valid {
		fmt.Printf("Description: %s\n", selected.Description.String)
	}

	// Step 4: Find the "in_progress" column
	var inProgressColumnID string
	err = db.QueryRow("SELECT id FROM columns WHERE name = '进行中'").Scan(&inProgressColumnID)
	if err != nil {
		log.Fatal("Could not find '进行中' column:", err)
	}

	// Step 5: Move task to in_progress
	_, err = db.Exec("UPDATE tasks SET column_id = ?, updated_at = ? WHERE id = ?",
		inProgressColumnID, time.Now().Format(time.RFC3339), selected.ID)
	if err != nil {
		log.Fatal("Failed to move task to in_progress:", err)
	}
	fmt.Printf("\n✓ Task moved to 'in_progress' (locked)\n")

	// Output the selected task ID for the next steps
	fmt.Printf("\nTASK_ID=%s\n", selected.ID)
}
