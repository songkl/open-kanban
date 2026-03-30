# Open kanban

一款专为 AI 时代打造的Agent流水线，让你的 AI 助手能够自主完成工作任务。

> **⚠️ 纯 Vibe 项目**：本项目完全由 AI Agent 构建，人类作者（songkl, skl@songkl.com）未写一行代码。


[English Version](./README.md)

## 核心特性

### 🤖 AI-First 设计
- **MCP 原生集成** - 开箱即用的 Model Context Protocol 支持
- **智能列配置** - 为不同 AI Agent 分配合适的任务列
- **自主工作流** - AI 可独立创建、更新、移动、评论任务

### ✨ 现代化协作体验
- **拖拽操作** - 流畅的卡片拖拽排序
- **实时同步** - WebSocket 毫秒级状态更新
- **多看板管理** - 项目隔离，权限分级
- **评论与讨论** - 任务内直接沟通
- **子任务拆解** - 大任务化繁为简

### 💾 可靠的数据管理
- **草稿箱** - 任务暂存，批量发布
- **历史归档** - 完成任务自动归档
- **文件附件** - 上传图片、文档到任务
- **SQLite/MySQL** - 轻量或生产级数据库自由切换

## 技术架构

| 组件 | 技术栈 |
|------|--------|
| 后端 API | Go + Gin |
| 数据库 | SQLite / MySQL |
| 前端 | React 19 + TypeScript |
| 样式 | TailwindCSS 4 |
| 拖拽 | dnd-kit |
| AI 协议 | MCP (Model Context Protocol) |

## 快速开始

### 启动后端

```bash
cd backend
go mod download
go run cmd/server/main.go
# 服务运行在 http://localhost:8080
```

### 启动前端

```bash
cd frontend
npm install
npm run dev
# 访问 http://localhost:5173
```

## AI Agent 集成

### 一键接入 / One-Step Setup

在 Claude Code、Cursor 或 OpenCode 中添加 MCP 配置。

Add MCP configuration to Claude Code, Cursor, or OpenCode.

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

> **注意 / Note:** 在登录后通过 `GET /api/auth/token` 获取 Token，或使用 CLI 命令重置密码：
> `./kanban-server reset-password -user <nickname> -password <newpassword>`
>
> Generate your `KANBAN_MCP_TOKEN` via `GET /api/auth/token` after logging in, or use the CLI command above to reset your password.

详细安装指南（包括 OpenCode Skill 配置）请查看[安装文档](./docs/INSTALL.md)。
For detailed installation instructions (including OpenCode skill setup), see [Installation Guide](./docs/INSTALL_EN.md)。

### AI 能力矩阵

| 能力 | 工具 |
|------|------|
| 任务管理 | `create_task`, `update_task`, `delete_task` |
| 任务查询 | `list_tasks`, `get_task`, `list_drafts` |
| 状态流转 | `update_task(status)`, `archive_task` |
| 评论协作 | `add_comment`, `list_comments` |
| 任务拆解 | `create_subtask`, `update_subtask` |
| 看板浏览 | `list_boards`, `list_columns` |

### 任务工作流

```
待办 → 进行中 → 待审核 → 已完成 → 归档
```

AI 可以自主推进任务状态，或通过评论记录决策过程。

## 项目结构

```
open-kanban/
├── backend/                    # Go API 服务
│   ├── cmd/server/            # 入口
│   └── internal/
│       ├── handlers/          # HTTP 处理器
│       ├── models/            # 数据模型
│       └── database/          # 数据库 & 迁移
├── frontend/                  # React SPA
│   ├── src/
│   │   ├── components/        # 看板组件
│   │   ├── pages/             # 页面路由
│   │   └── services/          # API 调用
│   └── dist/                  # 构建产物
├── scripts/                   # 构建脚本
│   ├── build.sh               # 开发构建
│   └── release.sh             # 全平台发布
├── docs/                      # 文档
│   ├── INSTALL.md             # 安装指南（中文）
│   └── INSTALL_EN.md          # Installation guide (English)
├── mcp-server/                # MCP Server npm 包
└── mcp/MCP_SETUP.md          # MCP 集成指南
```

## 环境变量

### 后端

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 8080 | 服务端口 |
| `DB_TYPE` | sqlite | sqlite 或 mysql |
| `DATABASE_URL` | kanban.db | SQLite 路径 |
| `DB_HOST` | localhost | MySQL 主机 |
| `DB_NAME` | kanban | MySQL 库名 |

### MCP Server

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `KANBAN_API_URL` | http://localhost:8080 | API 地址 |
| `KANBAN_MCP_TOKEN` | - | 认证 Token |

## 构建发布

```bash
# 开发构建（当前平台）
./scripts/build.sh

# 全平台发布（含 macOS/Linux/Windows）
./scripts/release.sh

# 发布 MCP Server 到 npm
cd mcp-server && npm publish
```

### 产物目录

```
release/
├── web/                              # 前端静态文件
├── kanban-server-darwin-amd64        # macOS Intel
├── kanban-server-darwin-arm64        # macOS Apple Silicon
├── kanban-server-linux-amd64         # Linux x64
├── kanban-server-linux-arm64         # Linux ARM
└── kanban-server-windows-amd64.exe   # Windows
```

## API 概览

### 认证与用户
- `POST /api/auth/login` - 登录/创建用户
- `GET /api/auth/me` - 当前用户信息
- `POST /api/auth/token` - 创建 API Token

### 看板与列
- `GET/POST /api/boards` - 列出/创建看板
- `GET/POST /api/columns` - 列出/创建列

### 任务
- `GET/POST /api/tasks` - 列出/创建任务
- `PUT /api/tasks/:id` - 更新任务
- `POST /api/tasks/:id/archive` - 归档任务

### 其他
- `GET /api/drafts` - 草稿列表
- `GET /api/archived` - 归档列表
- `POST /api/upload` - 文件上传
- `GET /ws` - WebSocket 实时同步

## License

MIT
