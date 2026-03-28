# KL-Kanban MCP & Skill 配置指南 (OpenClaw)

本文档供 OpenClaw 阅读和配置 KL-Kanban MCP Server 及 do-kanban Skill。

---

## MCP Server 配置

### 配置内容

```json
{
  "mcpServers": {
    "kanban": {
      "command": "npx",
      "args": ["tsx", "/Users/kl/Documents/ai/kl-kanban/mcp-server/index.ts"],
      "env": {
        "KANBAN_API_URL": "http://localhost:8080"
      }
    }
  }
}
```

### 安装 MCP Server

```bash
cd /Users/kl/Documents/ai/kl-kanban/mcp-server
npm install
npm run build
```

### MCP 可用工具列表

| 工具名称 | 描述 | 参数 |
|----------|------|------|
| `get_status` | 获取看板服务状态 | 无 |
| `list_boards` | 列出所有看板 | 无 |
| `list_columns` | 列出看板的列 | boardId (可选) |
| `list_tasks` | 列出任务 | boardId, columnId, status, agentType (可选) |
| `get_task` | 获取任务详情 | id (必填) |
| `create_task` | 创建任务 | title (必填), description, columnId, status, priority, assignee, meta, published |
| `update_task` | 更新任务 | id (必填), title, description, priority, assignee, meta, columnId, status |
| `delete_task` | 删除任务 | id (必填) |
| `publish_task` | 发布/取消发布 | id (必填), published |
| `archive_task` | 归档/取消归档 | id (必填), archived |
| `list_drafts` | 列出草稿 | boardId (可选) |
| `list_archived_tasks` | 列出已归档任务 | boardId (可选) |
| `add_comment` | 添加评论 | taskId (必填), content (必填), author |
| `list_comments` | 列出评论 | taskId (必填) |
| `list_subtasks` | 列出子任务 | taskId (必填) |
| `create_subtask` | 创建子任务 | taskId (必填), title (必填) |
| `update_subtask` | 更新子任务 | id (必填), title, completed |
| `delete_subtask` | 删除子任务 | id (必填) |

### 任务状态值

- `todo` - 待办
- `in_progress` - 进行中
- `review` - 待审核
- `done` - 已完成

### 优先级值

- `low` - 低
- `medium` - 中
- `high` - 高

---

## Skill 配置

### Skill 名称

`do-kanban`

### Skill 描述

Use the kanban MCP tools to pick and execute a pending task end-to-end

### Skill 文件路径

`~/.config/opencode/skills/do-kanban/SKILL.md`

### Skill 内容

```markdown
---
name: do-kanban
description: Use the kanban MCP tools to pick and execute a pending task end-to-end
---

# Kanban Do Skill

Use the kanban MCP tools to pick and execute a pending task end-to-end:

## Steps

1. **获取待办任务** — 调用 `mcp__kanban__list_tasks` 并传入 `status: "todo"` 获取所有待办任务。如果没有待办任务，告知用户并停止。获取时要注意用户是否给了 board或boardId,和 status

2. **选择任务（自动按优先级）** — 按以下规则自动选择任务，无需人工参与：
   - 首先按优先级排序：high > medium > low
   - 如果多个任务优先级相同，选择 ID 最小的任务（最早创建的任务）
   - 告知用户已自动选择的任务标题和优先级

3. **立即移动到进行中（抢锁）** — 调用 `mcp__kanban__update_task` 将选中任务的 `status` 改为 `in_progress`，确保其他用户无法同时选择该任务。告知用户任务已锁定并开始处理。

4. **读取任务详情** — 调用 `mcp__kanban__get_task` 获取完整任务描述，仔细阅读并理解需要完成的工作内容。

5. **执行任务** — 根据任务描述完整地执行工作：编写代码、修改文件、调试问题等。认真完成任务要求的所有内容。

6. **添加完成评论** — 调用 `mcp__kanban__add_comment` 为任务添加评论，总结：
   - 完成了哪些工作
   - 修改了哪些文件（如有）
   - 需要审核的要点

7. **移动到待审核** — 调用 `mcp__kanban__update_task` 将任务 `status` 改为 `review`，告知用户任务已完成并等待审核。

## 错误处理

- 若 kanban MCP 不可用：提示用户检查 MCP 服务器配置
- 若任务移动失败（可能已被其他用户抢占）：返回步骤1重新选择其他任务
- 若任务描述不清晰：调用 `mcp__kanban__add_comment` 添加评论说明任务描述不清晰，无法执行的具体原因，然后退出本次执行
- 若执行过程中遇到阻塞：在评论中说明进度和阻塞原因，再移动到 review
```

---

## 快速配置命令

### 1. 安装 MCP Server 依赖

```bash
cd /Users/kl/Documents/ai/kl-kanban/mcp-server && npm install && npm run build
```

### 2. 配置 OpenClaw MCP

在 OpenClaw 配置文件中添加：

```json
{
  "mcpServers": {
    "kanban": {
      "command": "npx",
      "args": ["tsx", "/Users/kl/Documents/ai/kl-kanban/mcp-server/index.ts"],
      "env": {
        "KANBAN_API_URL": "http://localhost:8080"
      }
    }
  }
}
```

### 3. 配置 do-kanban Skill

```bash
mkdir -p ~/.config/opencode/skills/do-kanban
```

将上述 Skill 内容写入 `~/.config/opencode/skills/do-kanban/SKILL.md`

### 4. 验证安装

```bash
# 检查后端是否运行
curl http://localhost:8080/api/boards

# 在 OpenClaw 中测试
list_tasks status=todo
```

---

## 使用方式

### 使用 MCP 工具

```
list_tasks status=todo
get_task id=<task-id>
create_task title="新任务" status=todo priority=high
update_task id=<task-id> status=in_progress
add_comment taskId=<task-id> content="完成" author="AI"
```

### 使用 Skill

```
/do-kanban
```

AI 将自动选取最高优先级任务并执行。
