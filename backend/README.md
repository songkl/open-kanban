# Kanban Go Server

A Go rewrite of the Next.js Kanban server using Gin framework and SQLite.

## Features

- RESTful API matching the original Next.js implementation
- SQLite database with migrations
- Cookie-based authentication
- User roles (ADMIN, USER) and types (HUMAN, AGENT)
- Board permissions (READ, WRITE, ADMIN)
- WebSocket broadcast support (optional)

## Project Structure

```
kanban-go/
├── cmd/server/          # Main application entry point
│   └── main.go
├── internal/
│   ├── handlers/        # HTTP handlers
│   │   ├── auth.go      # Authentication handlers
│   │   ├── boards.go    # Board handlers
│   │   ├── columns.go   # Column handlers
│   │   ├── tasks.go     # Task handlers
│   │   ├── comments.go  # Comment handlers
│   │   ├── subtasks.go  # Subtask handlers
│   │   └── archived.go  # Archived/draft handlers
│   ├── models/          # Data models
│   │   └── models.go
│   └── database/        # Database initialization
│       └── db.go
├── migrations/          # Database migrations
│   ├── 001_initial_schema.up.sql
│   └── 001_initial_schema.down.sql
├── go.mod
└── go.sum
```

## Installation

```bash
# Clone or create the project directory
cd kanban-go

# Download dependencies
go mod download

# Or use tidy
go mod tidy
```

## Running the Server

```bash
# Run directly
go run cmd/server/main.go

# Or build and run
go build -o server cmd/server/main.go
./server
```

The server will start on port 8080 by default. Set the `PORT` environment variable to change it.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8080 | Server port |
| `DATABASE_URL` | kanban.db | SQLite database file path |

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login/create user
- `GET /api/auth/login` - Get preset avatars
- `GET /api/auth/me` - Get current user
- `GET /api/auth/token` - List user tokens
- `POST /api/auth/token` - Create token
- `DELETE /api/auth/token` - Delete token
- `GET /api/auth/users` - List all users (ADMIN only)
- `PUT /api/auth/users` - Update user (ADMIN only)
- `GET /api/auth/permissions` - Get user permissions
- `POST /api/auth/permissions` - Set permission (ADMIN only)
- `DELETE /api/auth/permissions` - Delete permission (ADMIN only)

### Boards
- `GET /api/boards` - List all boards
- `POST /api/boards` - Create board
- `PUT /api/boards/:id` - Update board
- `DELETE /api/boards/:id` - Delete board (soft delete)

### Columns
- `GET /api/columns` - List columns
- `POST /api/columns` - Create column
- `PUT /api/columns` - Update column
- `DELETE /api/columns?id=:id` - Delete column
- `GET /api/columns/:columnId/agent` - Get column agent config
- `POST /api/columns/:columnId/agent` - Set column agent config (ADMIN only)
- `DELETE /api/columns/:columnId/agent` - Delete column agent config (ADMIN only)

### Tasks
- `GET /api/tasks?columnId=:id` - List tasks
- `POST /api/tasks` - Create task
- `GET /api/tasks/:id` - Get task
- `PUT /api/tasks/:id` - Update task
- `DELETE /api/tasks/:id` - Delete task
- `POST /api/tasks/:id/archive` - Archive/unarchive task

### Comments
- `GET /api/comments?taskId=:id` - List comments
- `POST /api/comments` - Create comment

### Subtasks
- `GET /api/subtasks?taskId=:id` - List subtasks
- `POST /api/subtasks` - Create subtask
- `PUT /api/subtasks/:id` - Update subtask
- `DELETE /api/subtasks/:id` - Delete subtask

### Archived & Drafts
- `GET /api/archived?boardId=:id` - List archived tasks
- `GET /api/drafts?boardId=:id` - List draft tasks

## Default Board Columns

When creating a new board, the following columns are automatically created:

1. 待办 (Todo) - #ef4444
2. 进行中 (In Progress) - #f59e0b
3. 待测试 (Testing) - #8b5cf6
4. 待审核 (Review) - #3b82f6
5. 已完成 (Done) - #22c55e

## Database Schema

The database uses SQLite with the following tables:

- `users` - User accounts
- `tokens` - Authentication tokens
- `boards` - Kanban boards
- `board_permissions` - User permissions for boards
- `columns` - Board columns
- `column_agents` - Agent configuration for columns
- `tasks` - Task cards
- `comments` - Task comments
- `subtasks` - Task subtasks

## Authentication
The server uses cookie-based authentication with the `kanban-token` cookie. The first user to log in automatically becomes an ADMIN.

## WebSocket Broadcast

The server attempts to broadcast refresh events to a WebSocket server at `http://localhost:8081/broadcast`. This is optional and errors are silently ignored.

## CLI Commands

```bash
# Reset user password
./kanban-server reset-password -user <nickname> -password <newpassword>

# Example: reset admin password
./kanban-server reset-password -user admin -password MyNewPass123

# Show help
./kanban-server help
```
