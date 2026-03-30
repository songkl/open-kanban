# open-kanban Installation Guide

This guide covers installing open-kanban MCP Server and OpenCode Skill for AI-powered autonomous task execution.

## Table of Contents

- [MCP Server Installation](#mcp-server-installation)
- [OpenCode Skill Installation](#opencode-skill-installation)
- [Complete Configuration Example](#complete-configuration-example)
- [Verification](#verification)

---

## MCP Server Installation

### Prerequisites

- Node.js >= 18.0.0
- Running open-kanban backend service

### Method 1: npm Install (Recommended)

```bash
npm install -g open-kanban-mcp
```

### Method 2: Local Source

```bash
cd open-kanban/mcp-server
npm install
npm run build
```

### Configure AI Tools

#### OpenCode

Edit `~/.config/opencode/config.json` or project `.opencode/config.json`:

```json
{
  "mcpServers": {
    "kanban": {
      "command": "open-kanban-mcp",
      "env": {
        "KANBAN_API_URL": "http://localhost:8080"
      }
    }
  }
}
```

#### Claude Code / Cursor

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "kanban": {
      "command": "npx",
      "args": ["-y", "open-kanban-mcp"],
      "env": {
        "KANBAN_API_URL": "http://localhost:8080"
      }
    }
  }
}
```

#### Local Source Mode

```json
{
  "mcpServers": {
    "kanban": {
      "command": "npx",
      "args": ["tsx", "/path/to/open-kanban/mcp-server/index.ts"],
      "env": {
        "KANBAN_API_URL": "http://localhost:8080"
      }
    }
  }
}
```

---

## OpenCode Skill Installation

### About the Skill

The `do-kanban` skill enables OpenCode to autonomously pick and execute tasks from the board:

1. Fetch pending tasks (sorted by priority)
2. Lock the task (move to in-progress)
3. Read task details
4. Execute the task
5. Add completion comment
6. Move to review

### Installation Steps

#### 1. Create Skill Directory

```bash
mkdir -p ~/.config/opencode/skills/do-kanban
```

#### 2. Create Skill File

Save the following to `~/.config/opencode/skills/do-kanban/SKILL.md`:

```markdown
---
name: do-kanban
description: Use the kanban MCP tools to pick and execute a pending task end-to-end
---

# Kanban Do Skill

Use the kanban MCP tools to pick and execute a pending task end-to-end:

## Steps

1. **Fetch Todo Tasks** — Call `mcp__kanban__list_tasks` with `status: "todo"` to get all pending tasks. If no tasks available, inform the user and stop. Note if user provided a board/boardId and status.

2. **Select Task (Auto by Priority)** — Automatically select task without user intervention:
   - Sort by priority: high > medium > low
   - If same priority, select task with lowest ID (earliest created)
   - Inform user about selected task title and priority

3. **Move to In Progress (Lock)** — Call `mcp__kanban__update_task` to change task `status` to `in_progress`. This locks the task for other users. Inform user task is locked and being processed.

4. **Read Task Details** — Call `mcp__kanban__get_task` to get full task description and understand the work required.

5. **Execute Task** — Complete all work described in the task: write code, modify files, debug issues, etc.

6. **Add Completion Comment** — Call `mcp__kanban__add_comment` summarizing:
   - What was completed
   - Files modified (if any)
   - Points needing review

7. **Move to Review** — Call `mcp__kanban__update_task` to change `status` to `review`. Inform user task is complete and awaiting review.

## Error Handling

- If kanban MCP unavailable: prompt user to check MCP server configuration
- If task move fails (may be taken by another user): return to step 1 to select another task
- If task description is unclear: add comment explaining why, then exit
- If blocked during execution: explain progress and blocking reason in comment, then move to review
```

#### 3. Verify Skill Loading

When starting OpenCode, check logs for:

```
Loaded skill: do-kanban
```

### Using the Skill

In OpenCode, type:

```
/do-kanban
```

AI will automatically:
1. Fetch all pending tasks
2. Select the highest priority task
3. Start execution
4. Notify you when complete for review

---

## Complete Configuration Example

### OpenCode Config (`~/.config/opencode/config.json`)

```json
{
  "mcpServers": {
    "kanban": {
      "command": "open-kanban-mcp",
      "env": {
        "KANBAN_API_URL": "http://localhost:8080",
        "KANBAN_MCP_TOKEN": ""  // Optional: auth token
      }
    }
  }
}
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `KANBAN_API_URL` | open-kanban backend API URL |
| `KANBAN_MCP_TOKEN` | Optional authentication token |

---

## Verification

### 1. Check MCP Server

```bash
# Test if MCP Server runs correctly
npx open-kanban-mcp --help
```

### 2. Check Tool Availability

In your AI tool's console:

```
list_tasks status=todo
```

Should return the pending tasks from your board.

### 3. Test Skill

In OpenCode:

```
/do-kanban
```

AI should start picking and executing tasks from the board.

---

## Troubleshooting

### MCP Server Fails to Start

1. Check Node.js version: `node --version` (needs >= 18)
2. Check backend is running: `curl http://localhost:8080/api/boards`
3. Check error logs

### Skill Not Loading

1. Verify skill file path: `~/.config/opencode/skills/do-kanban/SKILL.md`
2. Verify OpenCode config has skills enabled
3. Restart OpenCode

### No Tasks Retrieved

1. Verify board has tasks in "todo" status
2. Check `KANBAN_API_URL` is configured correctly
3. Confirm tasks are in the correct column
