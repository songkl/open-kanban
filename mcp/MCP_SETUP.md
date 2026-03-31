# 看板 MCP 集成指南

## 功能概览

看板 MCP 服务器为 AI 助手提供以下能力：

- 📋 **任务管理**：创建、编辑、删除、移动任务
- 📝 **子任务**：添加子任务、标记完成
- 💬 **评论**：任务讨论和沟通
- 🏷️ **元信息**：支持自定义键值对（如标签、预估工时等）
- 📁 **看板管理**：多看板支持（scopespace）
- 🔄 **实时同步**：通过 WebSocket 自动刷新

## 启动看板应用


**注意：MCP 服务器通过 HTTP API 访问数据，不再依赖本地 SQLite 文件。**

## MCP Server 集成

### OpenCursor / Claude Code 配置

在 MCP 配置文件中添加：

```json
{
  "mcpServers": {
    "kanban": {
      "command": "npx",
      "args": ["tsx", "mcp-server/index.ts"]
    }
  }
}
```

**可选：配置远程 API**
```json
{
  "mcpServers": {
    "kanban": {
      "command": "npx",
      "args": ["tsx", "mcp-server/index.ts"],
      "env": {
        "KANBAN_API_URL": "http://192.168.1.100:3000"
      }
    }
  }
}
```

## 任务流向

看板任务按照以下流程流转：

```
待办 → 进行中 → 待审核 → 已完成
```

| 状态 | 看板列 | 说明 |
|------|--------|------|
| `todo` | 待办 | 新创建的任务 |
| `in_progress` | 进行中 | 开始执行的任务 |
| `review` | 待审核 | 等待审核的任务 |
| `done` | 已完成 | 审核通过的任务 |

**注意：** Column ID 格式为 `{boardId}_{status}`，如 `{boardId}_todo`、`{boardId}_doing`。

### 移动任务

推荐使用 `status` 参数（自动映射到正确的列）：

```typescript
// 任务开始执行：待办 → 进行中
update_task({ id: "任务ID", status: "in_progress" })

// 任务需要审核：进行中 → 待审核
update_task({ id: "任务ID", status: "review" })

// 审核通过：待审核 → 已完成
update_task({ id: "任务ID", status: "done" })
```

也可以使用 `columnId` 直接指定列：

```typescript
update_task({ id: "任务ID", columnId: "{boardId}_doing" })
```

### 子任务操作

```typescript
// 查看子任务
list_subtasks({ taskId: "任务ID" })

// 添加子任务
create_subtask({ taskId: "任务ID", title: "子任务标题" })

// 标记子任务完成/未完成
update_subtask({ id: "子任务ID", completed: true })

// 删除子任务
delete_subtask({ id: "子任务ID" })
```

## 可用工具

### 任务查询

| 工具 | 描述 |
|------|------|
| `get_status` | 获取看板服务状态（在线/离线、延迟、看板数量） |
| `list_boards` | 列出所有看板（只读） |
| `list_columns` | 列出看板的列 |
| `list_tasks` | 列出任务，支持多种筛选条件 |
| `get_task` | 获取任务详情（含所有评论） |
| `list_drafts` | 列出所有草稿（未发布任务） |
| `list_archived_tasks` | 列出已归档任务 |
| `get_dashboard_stats` | 获取看板统计信息 |
| `list_my_tasks` | 获取当前Agent负责的任务 |

### 任务操作

| 工具 | 描述 |
|------|------|
| `create_task` | 创建新任务（支持草稿） |
| `update_task` | 更新任务信息 |
| `delete_task` | 删除任务 |
| `publish_task` | 发布/取消发布任务 |
| `archive_task` | 归档/取消归档任务 |

### 评论操作

| 工具 | 描述 |
|------|------|
| `add_comment` | 为任务添加评论 |
| `list_comments` | 列出任务的评论 |

### 子任务操作

| 工具 | 描述 |
|------|------|
| `list_subtasks` | 列出任务的子任务 |
| `create_subtask` | 创建子任务 |
| `update_subtask` | 更新子任务（标记完成） |
| `delete_subtask` | 删除子任务 |

## 详细使用说明

### 按状态筛选任务

```typescript
// 查看所有待办任务
list_tasks({ status: "todo" })

// 查看进行中任务
list_tasks({ status: "in_progress" })

// 查看待审核任务
list_tasks({ status: "review" })

// 查看已完成任务
list_tasks({ status: "done" })

// 查看指定列的任务
list_tasks({ columnId: "列ID" })

// 按优先级筛选
list_tasks({ priority: "high" })

// 按负责人筛选
list_tasks({ assignee: "张三" })

// 按关键词搜索（标题和描述）
list_tasks({ searchQuery: "bug" })

// 按时间范围筛选
list_tasks({ dateRange: "today" })    // 今天
list_tasks({ dateRange: "thisWeek" }) // 本周
list_tasks({ dateRange: "thisMonth" })// 本月

// 按标签筛选（匹配 meta 中的值）
list_tasks({ tag: "bug" })

// 按 Agent 类型筛选
list_tasks({ agentType: "coder" })
```

### 查看任务详情（含讨论记录）

```typescript
// 获取任务详情和所有评论
get_task({ id: "任务ID" })
// 返回: 任务信息 + comments 数组（包含所有讨论记录）
```

### 创建任务

```typescript
// 创建并发布到看板
create_task({ 
  title: "新任务", 
  status: "todo",
  priority: "high",
  description: "任务描述"
})

// 创建带元信息的任务
create_task({ 
  title: "新任务", 
  status: "todo",
  meta: { "标签": "bug", "预估工时": "4h" }
})

// 创建草稿（不发布）
create_task({ 
  title: "草稿任务", 
  published: false 
})
```

### 更新任务

```typescript
// 更新任务信息
update_task({ 
  id: "任务ID",
  title: "新标题",
  description: "新描述",
  priority: "high"
})

// 更新元信息
update_task({ 
  id: "任务ID",
  meta: { "标签": "feature", "预估工时": "8h" }
})

// 添加新的元信息（保留原有并追加）
update_task({ 
  id: "任务ID",
  meta: { ...现有meta, "新键": "新值" }
})
})

// 移动任务到其他列
update_task({ 
  id: "任务ID",
  status: "in_progress"  // 或 columnId: "列ID"
})
```

### 特殊操作

```typescript
// 获取看板统计信息
get_dashboard_stats()
// 返回: 各状态任务数量、优先级统计、发布状态等

// 标记任务完成并自动流转到下一列
complete_task({ id: "任务ID" })
// 任务会根据列排序自动移动到下一列

// 获取当前Agent负责的任务
list_my_tasks()
// 根据当前token对应的Agent类型和分配的任务，返回该Agent应该处理的任务
```

### 发布/归档操作

```typescript
// 发布草稿任务到看板
publish_task({ id: "任务ID", published: true })

// 取消发布（转为草稿）
publish_task({ id: "任务ID", published: false })

// 归档任务
archive_task({ id: "任务ID", archived: true })

// 取消归档
archive_task({ id: "任务ID", archived: false })
```

### 评论操作

```typescript
// 添加评论
add_comment({ 
  taskId: "任务ID", 
  content: "讨论内容",
  author: "评论者名称"
})

// 查看任务评论
list_comments({ taskId: "任务ID" })
// 或使用 get_task 获取完整信息（含评论）
```

## 完整对话示例

```
用户: 查看所有待办任务
AI: 调用 list_tasks({ status: "todo" })

用户: 查看这个任务的详情和讨论
AI: 调用 get_task({ id: "任务ID" })
// 返回包含任务信息和所有评论

用户: 创建一个新任务 "完成报告"
AI: 调用 create_task({ 
  title: "完成报告", 
  status: "todo", 
  priority: "medium" 
})

用户: 任务有更新，需要讨论
AI: 调用 add_comment({ 
  taskId: "任务ID", 
  content: "请检查最新修改", 
  author: "AI助手" 
})

用户: 把这个任务移到进行中
AI: 调用 update_task({ 
  id: "任务ID", 
  status: "in_progress" 
})

用户: 任务完成了，归档它
AI: 调用 archive_task({ id: "任务ID", archived: true })
```

## 任务状态说明

### published - 发布状态
- `true` - 任务显示在看板
- `false` - 任务保存在草稿箱

### archived - 归档状态
- `true` - 任务移动到历史归档
- `false` - 任务正常显示

### status - 看板列状态（用于筛选）
| status | 看板列 |
|--------|--------|
| `todo` | 待办 |
| `in_progress` | 进行中 |
| `review` | 待审核 |
| `done` | 已完成 |

### priority - 优先级
| priority | 说明 |
|----------|------|
| `low` | 低 |
| `medium` | 中 |
| `high` | 高 |

### meta - 元信息
| 属性 | 说明 |
|------|------|
| 类型 | JSON 对象 |
| 示例 | `{ "标签": "bug", "预估工时": "4h", "截止日期": "2024-01-15" }` |
| 用途 | 存储自定义键值对，如标签、工时、截止日期等 |

## 注意事项

1. 确保先启动看板应用 `npm run dev`
2. MCP 服务器通过 HTTP API 访问数据，支持远程连接
3. 所有通过 MCP 的更改会自动同步到看板 UI
4. 默认 API 地址为 `http://localhost:3000`，可通过环境变量 `KANBAN_API_URL` 覆盖
