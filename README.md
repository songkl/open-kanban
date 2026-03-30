# Open kanban

A collaborative kanban board built for the AI era — empowering your AI assistants to handle tasks autonomously.

> **⚠️ Pure Vibe Project**: This project was built entirely by AI agents. The human author (songkl, skl@songkl.com) did not write a single line of code.


[中文版本](./README_ZH.md)

## Highlights

### 🤖 AI-First Architecture
- **Native MCP Integration** - Out-of-the-box Model Context Protocol support
- **Smart Column Config** - Assign specific AI agents to designated columns
- **Autonomous Workflow** - AI creates, updates, moves, and comments on tasks independently

### ✨ Modern Collaboration
- **Drag & Drop** - Smooth card sorting and movement
- **Real-time Sync** - WebSocket-powered millisecond updates
- **Multi-Board** - Isolated projects with granular permissions
- **Comments** - In-task discussions and decisions
- **Subtasks** - Break down complex work

### 💾 Robust Data Management
- **Draft Box** - Stage tasks before publishing
- **Archive** - Organized completion history
- **File Attachments** - Images, docs, and more
- **SQLite/MySQL** - Embedded or production-grade database

## Tech Stack

| Component | Technology |
|-----------|------------|
| Backend API | Go + Gin |
| Database | SQLite / MySQL |
| Frontend | React 19 + TypeScript |
| Styling | TailwindCSS 4 |
| Drag & Drop | dnd-kit |
| AI Protocol | MCP (Model Context Protocol) |

## Quick Start

### One-Command Install (Recommended)

```bash
./scripts/install.sh
```

This will:
- Check port availability (8080, 5173)
- Install backend/frontend/mcp-server dependencies
- Output MCP and Skill configuration templates

### Manual Setup

**Start Backend:**

```bash
cd backend
go mod download
go run cmd/server/main.go
# Server runs on http://localhost:8080
```

**Start Frontend:**

```bash
cd frontend
npm install
npm run dev
# Visit http://localhost:5173
```

## AI Agent Integration

### One-Step Setup / 一键接入

Add MCP configuration to Claude Code, Cursor, or OpenCode.

在 Claude Code、Cursor 或 OpenCode 中添加 MCP 配置。

#### Claude Code / Open-Claw 配置

```json
{
  "mcpServers": {
    "kanban": {
      "command": "npx",
      "args": ["-y", "open-kanban-mcp@latest"],
      "env": {
        "KANBAN_API_URL": "http://localhost:8080",
        "KANBAN_MCP_TOKEN": "{YOUR_KANBAN_TOKEN}"
      }
    }
  }
}
```

#### OpenCode 配置 / OpenCode Configuration

```json
"mcp": {
  "kanban": {
    "command": ["npx", "-y", "open-kanban-mcp@latest"],
    "enabled": true,
    "type": "local",
    "environment": {
      "KANBAN_API_URL": "http://localhost:8080",
      "KANBAN_MCP_TOKEN": "YOUR_KANBAN_TOKEN"
    }
  }
}
```

> **Note / 注意:** Generate your `KANBAN_MCP_TOKEN` via `GET /api/auth/token` after logging in, or use the CLI command `./kanban-server reset-password -user <nickname> -password <newpassword>` to reset your password.
>
> 在登录后通过 `GET /api/auth/token` 获取 Token，或使用 CLI 命令重置密码。

For detailed installation instructions (including OpenCode skill setup), see [Installation Guide](./docs/INSTALL_EN.md).
详细安装指南（包括 OpenCode Skill 配置）请查看[安装文档](./docs/INSTALL.md)。

### AI Capability Matrix

| Capability | Tools |
|------------|-------|
| Task Management | `create_task`, `update_task`, `delete_task` |
| Task Query | `list_tasks`, `get_task`, `list_drafts` |
| Status Flow | `update_task(status)`, `archive_task` |
| Collaboration | `add_comment`, `list_comments` |
| Subtasks | `create_subtask`, `update_subtask` |
| Board Navigation | `list_boards`, `list_columns` |

### Task Workflow

```
Todo → In Progress → Review → Done → Archived
```

AI agents can autonomously advance task status and record decisions via comments.

## Project Structure

```
open-kanban/
├── backend/                    # Go API server
│   ├── cmd/server/            # Entry point
│   └── internal/
│       ├── handlers/          # HTTP handlers
│       ├── models/            # Data models
│       └── database/          # DB & migrations
├── frontend/                  # React SPA
│   ├── src/
│   │   ├── components/        # Kanban components
│   │   ├── pages/             # Route pages
│   │   └── services/          # API services
│   └── dist/                  # Build output
├── scripts/                   # Build scripts
│   ├── build.sh               # Dev build
│   └── release.sh             # Cross-platform release
├── docs/                      # Documentation
│   ├── INSTALL.md             # Installation guide (中文)
│   └── INSTALL_EN.md          # Installation guide (English)
├── mcp-server/                # MCP Server npm package
└── mcp/MCP_SETUP.md          # MCP integration guide
```

## Environment Variables

### Backend

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8080 | Server port |
| `DB_TYPE` | sqlite | sqlite or mysql |
| `DATABASE_URL` | kanban.db | SQLite path |
| `DB_HOST` | localhost | MySQL host |
| `DB_NAME` | kanban | MySQL database |

### MCP Server

| Variable | Default | Description |
|----------|---------|-------------|
| `KANBAN_API_URL` | http://localhost:8080 | API URL |
| `KANBAN_MCP_TOKEN` | - | Auth token |

## Build & Release

```bash
# Dev build (current platform)
./scripts/build.sh

# Cross-platform release (macOS/Linux/Windows)
./scripts/release.sh

# Publish MCP Server to npm
cd mcp-server && npm publish
```

### Release Output

```
release/
├── web/                              # Frontend assets
├── kanban-server-darwin-amd64        # macOS Intel
├── kanban-server-darwin-arm64        # macOS Apple Silicon
├── kanban-server-linux-amd64         # Linux x64
├── kanban-server-linux-arm64         # Linux ARM
└── kanban-server-windows-amd64.exe   # Windows
```

## API Overview

### Auth & Users
- `POST /api/auth/login` - Login/create user
- `GET /api/auth/me` - Current user info
- `POST /api/auth/token` - Create API token

### Boards & Columns
- `GET/POST /api/boards` - List/create boards
- `GET/POST /api/columns` - List/create columns

### Tasks
- `GET/POST /api/tasks` - List/create tasks
- `PUT /api/tasks/:id` - Update task
- `POST /api/tasks/:id/archive` - Archive task

### More
- `GET /api/drafts` - Draft list
- `GET /api/archived` - Archive list
- `POST /api/upload` - File upload
- `GET /ws` - WebSocket realtime

## License

MIT
