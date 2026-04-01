# Open Kanban MCP Server

MCP Server for Open Kanban board, enabling AI assistants to interact with kanban tasks via the Model Context Protocol.

> **GitHub:** https://github.com/songkl/open-kanban

## Features

- Full task management: create, update, delete, archive tasks
- Board and column navigation
- Comment and subtask support
- Draft task management
- Native MCP SDK integration

## Installation

```bash
npm install
npm run build
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `KANBAN_API_URL` | http://localhost:8080 | Kanban API server URL |
| `KANBAN_MCP_TOKEN` | - | Authentication token |

## Usage

```bash
# Via npx (recommended)
npx -y open-kanban-mcp

# Or run directly
./dist/index.js
```

## MCP Tools

### Status & Info
| Tool | Description |
|------|-------------|
| `get_status` | Get kanban service status |
| `get_dashboard_stats` | Get dashboard statistics |

### Board & Column
| Tool | Description |
|------|-------------|
| `list_boards` | List all boards |
| `get_board` | Get board details |
| `list_columns` | List board columns (supports position filtering) |
| `get_column` | Get column details |

### Task Management
| Tool | Description |
|------|-------------|
| `list_tasks` | List tasks with filters (column, status, priority, etc.) |
| `get_task` | Get task details |
| `create_task` | Create a new task |
| `update_task` | Update task (title, description, priority, assignee, etc.) |
| `delete_task` | Delete task |
| `complete_task` | Mark task complete and move to next column |

### Task Publishing
| Tool | Description |
|------|-------------|
| `list_drafts` | List draft tasks |
| `publish_task` | Publish/unpublish task |
| `list_archived_tasks` | List archived tasks |
| `archive_task` | Archive/unarchive task |

### Collaboration
| Tool | Description |
|------|-------------|
| `add_comment` | Add comment to task |
| `list_comments` | List task comments |

### Subtasks
| Tool | Description |
|------|-------------|
| `list_subtasks` | List task subtasks |
| `create_subtask` | Create subtask |
| `update_subtask` | Update subtask (title, completed) |
| `delete_subtask` | Delete subtask |

### Agent Integration
| Tool | Description |
|------|-------------|
| `list_my_tasks` | Get tasks assigned to current agent |

## License

MIT