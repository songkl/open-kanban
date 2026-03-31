# Open Kanban MCP Server

MCP Server for Open Kanban board, enabling AI assistants to interact with kanban tasks via the Model Context Protocol.

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

| Tool | Description |
|------|-------------|
| `list_boards` | List all boards |
| `list_columns` | List board columns |
| `list_tasks` | List tasks (optionally by column) |
| `get_task` | Get task details |
| `create_task` | Create a new task |
| `update_task` | Update task |
| `delete_task` | Delete task |
| `archive_task` | Archive/unarchive task |
| `add_comment` | Add comment to task |
| `list_comments` | List task comments |
| `create_subtask` | Create subtask |
| `update_subtask` | Update subtask |
| `delete_subtask` | Delete subtask |
| `list_drafts` | List draft tasks |
| `publish_task` | Publish draft to board |

## License

MIT