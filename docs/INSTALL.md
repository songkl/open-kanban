# KL-Kanban 安装指南

本指南介绍如何安装 KL-Kanban MCP Server 和 OpenCode Skill，实现 AI Agent 自动完成任务的工作流。

## 目录

- [MCP Server 安装](#mcp-server-安装)
- [OpenCode Skill 安装](#opencode-skill-安装)
- [完整配置示例](#完整配置示例)
- [验证安装](#验证安装)

---

## MCP Server 安装

### 前置要求

- Node.js >= 18.0.0
- 已运行的 KL-Kanban 后端服务

###方式一：npm 安装（推荐）

```bash
npm install -g kl-kanban-mcp
```

### 方式二：本地源码运行

```bash
cd kl-kanban/mcp-server
npm install
npm run build
```

### 配置 AI 工具

#### OpenCode

编辑 `~/.config/opencode/config.json` 或项目 `.opencode/config.json`：

```json
{
  "mcpServers": {
    "kanban": {
      "command": "kl-kanban-mcp",
      "env": {
        "KANBAN_API_URL": "http://localhost:8080"
      }
    }
  }
}
```

#### Claude Code / Cursor

在对应的 MCP 配置文件中添加：

```json
{
  "mcpServers": {
    "kanban": {
      "command": "npx",
      "args": ["-y", "kl-kanban-mcp"],
      "env": {
        "KANBAN_API_URL": "http://localhost:8080"
      }
    }
  }
}
```

#### 本地源码方式

```json
{
  "mcpServers": {
    "kanban": {
      "command": "npx",
      "args": ["tsx", "/path/to/kl-kanban/mcp-server/index.ts"],
      "env": {
        "KANBAN_API_URL": "http://localhost:8080"
      }
    }
  }
}
```

---

## OpenCode Skill 安装

### Skill 简介

`do-kanban` Skill 让 OpenCode 能够自主从看板选取待办任务并完成：

1. 获取待办任务（按优先级排序）
2. 自动锁定任务（移动到进行中）
3. 读取任务详情
4. 执行任务
5. 添加完成评论
6. 移动到待审核

### 安装步骤

#### 1. 创建 Skill 目录

```bash
mkdir -p ~/.config/opencode/skills/do-kanban
```

#### 2. 复制 Skill 文件

将以下内容保存到 `~/.config/opencode/skills/do-kanban/SKILL.md`：

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

#### 3. 验证 Skill 加载

启动 OpenCode 时，检查日志中是否包含：

```
Loaded skill: do-kanban
```

### 使用 Skill

在 OpenCode 中输入：

```
/do-kanban
```

AI 将自动：
1. 获取所有待办任务
2. 选择最高优先级的任务
3. 开始执行
4. 完成后通知你审核

---

## 完整配置示例

### OpenCode 配置 (`~/.config/opencode/config.json`)

```json
{
  "mcpServers": {
    "kanban": {
      "command": "kl-kanban-mcp",
      "env": {
        "KANBAN_API_URL": "http://localhost:8080",
        "KANBAN_MCP_TOKEN": ""  // 可选：设置认证 Token
      }
    }
  }
}
```

### 环境变量说明

| 变量 | 说明 |
|------|------|
| `KANBAN_API_URL` | KL-Kanban 后端 API 地址 |
| `KANBAN_MCP_TOKEN` | 可选认证 Token |

---

## 验证安装

### 1. 检查 MCP Server

```bash
# 测试 MCP Server 是否正常运行
npx kl-kanban-mcp --help
```

### 2. 检查工具可用性

在 AI 工具的控制台中执行：

```
list_tasks status=todo
```

应该返回看板中的待办任务列表。

### 3. 测试 Skill

在 OpenCode 中：

```
/do-kanban
```

AI 应该开始从看板选取并执行任务。

---

## 故障排除

### MCP Server 启动失败

1. 检查 Node.js 版本：`node --version`（需要 >= 18）
2. 检查后端服务：`curl http://localhost:8080/api/boards`
3. 查看错误日志

### Skill 未加载

1. 确认 Skill 文件路径正确：`~/.config/opencode/skills/do-kanban/SKILL.md`
2. 确认 OpenCode 配置中启用了 skills
3. 重启 OpenCode

### 任务获取为空

1. 确认看板中有待办状态的任务
2. 检查 `KANBAN_API_URL` 配置正确
3. 确认任务确实在正确的列中（待办列）
