import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";

const API_BASE = process.env.KANBAN_API_URL || "http://localhost:3000";
const MCP_TOKEN = process.env.KANBAN_MCP_TOKEN;
const MCP_REQUEST_HEADER = "X-MCP-Request";

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      ...(MCP_TOKEN ? { "Authorization": `Bearer ${MCP_TOKEN}` } : {}),
      [MCP_REQUEST_HEADER]: "true",
    },
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as any;
}

async function apiPost<T>(path: string, body: any): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      ...(MCP_TOKEN ? { "Authorization": `Bearer ${MCP_TOKEN}` } : {}),
      [MCP_REQUEST_HEADER]: "true",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as any;
}

async function apiPut<T>(path: string, body: any): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: { 
      "Content-Type": "application/json",
      ...(MCP_TOKEN ? { "Authorization": `Bearer ${MCP_TOKEN}` } : {}),
      [MCP_REQUEST_HEADER]: "true",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as any;
}

async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers: {
      ...(MCP_TOKEN ? { "Authorization": `Bearer ${MCP_TOKEN}` } : {}),
      [MCP_REQUEST_HEADER]: "true",
    },
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
}

async function broadcast() {
  try {
    await fetch("http://localhost:3001/broadcast", {
      method: "POST",
      body: JSON.stringify({ type: "refresh" }),
    });
  } catch (e) {
    // API server not running, ignore
  }
}

const server = new McpServer({
  name: "kanban-mcp-server",
  version: "1.3.0",
});

function createToolResult(content: string, isError = false): CallToolResult {
  return { content: [{ type: "text" as const, text: content }], isError };
}

function jsonToolResult(data: any): CallToolResult {
  return createToolResult(JSON.stringify(data, null, 2));
}

const StatusEnum = z.enum(["todo", "in_progress", "review", "done"]);
const PriorityEnum = z.enum(["low", "medium", "high"]);
const DateRangeEnum = z.enum(["today", "thisWeek", "thisMonth"]);

server.registerTool("get_status", {
  description: "获取看板服务状态",
  inputSchema: z.object({}),
}, async () => {
  try {
    const start = Date.now();
    await fetch(`${API_BASE}/api/boards`);
    const latency = Date.now() - start;
    const boards = await apiGet<any[]>("/api/boards");
    return jsonToolResult({
      status: "online",
      apiUrl: API_BASE,
      latencyMs: latency,
      boardsCount: boards.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return jsonToolResult({
      status: "offline",
      apiUrl: API_BASE,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

server.registerTool("list_boards", {
  description: "列出所有看板（只读）",
  inputSchema: z.object({}),
}, async () => {
  const boards = await apiGet<any[]>("/api/boards");
  const result = boards.map(({ _count, ...board }) => board);
  return jsonToolResult(result);
});

server.registerTool("get_board", {
  description: "获取单个看板的详细信息，包括描述",
  inputSchema: z.object({
    boardId: z.string().describe("看板ID"),
  }),
}, async ({ boardId }) => {
  const board = await apiGet<any>(`/api/boards/${boardId}`);
  if (!board || board.error) {
    return createToolResult("Board not found", true);
  }
  const { _count, ...rest } = board;
  return jsonToolResult(rest);
});

server.registerTool("list_columns", {
  description: "列出看板的列，包括状态描述和颜色信息，支持按位置过滤",
  inputSchema: z.object({
    boardId: z.string().optional().describe("看板ID，不填则使用第一个看板"),
    positions: z.array(z.number()).optional().describe("列的位置列表，可多选，如 [1, 3, 5] 表示获取第1、3、5位的列"),
  }),
}, async ({ boardId, positions }) => {
  let url = "/api/columns";
  const params = new URLSearchParams();
  if (boardId) params.set("boardId", boardId);
  if (positions && positions.length > 0) params.set("positions", positions.join(","));
  if (params.toString()) url += "?" + params.toString();
  const columns = await apiGet<any[]>(url);
  const result = columns.map(({ tasks, ...col }) => ({
    id: col.id,
    name: col.name,
    status: col.status,
    description: col.description || "",
    position: col.position,
    color: col.color,
    boardId: col.boardId,
  }));
  return jsonToolResult(result);
});

server.registerTool("get_column", {
  description: "获取单个列的详细信息，包括状态描述",
  inputSchema: z.object({
    columnId: z.string().describe("列ID"),
  }),
}, async ({ columnId }) => {
  const columns = await apiGet<any[]>("/api/columns");
  const col = columns.find((c: any) => c.id === columnId);
  if (!col) {
    return createToolResult("Column not found", true);
  }
  const { tasks, ...rest } = col;
  return jsonToolResult({
    ...rest,
    tasksCount: tasks?.length || 0,
  });
});

server.registerTool("list_tasks", {
  description: "列出所有任务或指定列的任务，支持多种筛选条件",
  inputSchema: z.object({
    boardId: z.string().optional().describe("看板ID，不填则使用第一个看板"),
    columnId: z.string().optional().describe("列ID，列出该列的所有任务"),
    status: StatusEnum.optional().describe("按状态筛选"),
    agentType: z.string().optional().describe("按 Agent 类型筛选"),
    priority: PriorityEnum.optional().describe("按优先级筛选"),
    assignee: z.string().optional().describe("按负责人筛选"),
    searchQuery: z.string().optional().describe("搜索任务标题和描述"),
    dateRange: DateRangeEnum.optional().describe("按创建时间筛选"),
    tag: z.string().optional().describe("按标签筛选"),
  }),
}, async (args) => {
  const boardId = args.boardId;
  const url = boardId ? `/api/columns?boardId=${boardId}` : "/api/columns";
  const columns = await apiGet<any[]>(url);

  let columnId = args.columnId;

  if (args.status && !columnId) {
    const statusMap: Record<string, string> = {
      "todo": "待办",
      "in_progress": "进行中",
      "review": "待审核",
      "done": "已完成",
    };
    const columnName = statusMap[args.status];
    if (columnName) {
      const col = columns.find((c: any) => c.name === columnName);
      if (col) {
        columnId = col.id;
      }
    }
  }

  let tasks: any[] = [];
  if (columnId) {
    const col = columns.find((c: any) => c.id === columnId);
    tasks = col?.tasks || [];
  } else {
    tasks = columns.flatMap((c: any) => c.tasks || []);
  }

  if (args.agentType) {
    tasks = tasks.filter((task: any) => {
      const col = columns.find((c: any) => c.id === task.columnId);
      if (!col?.agentConfig) return false;
      const allowedTypes = col.agentConfig.agentTypes || [];
      return allowedTypes.includes(args.agentType);
    });
  }

  if (args.priority) {
    tasks = tasks.filter((task: any) => task.priority === args.priority);
  }

  if (args.assignee) {
    tasks = tasks.filter((task: any) => task.assignee === args.assignee);
  }

  if (args.searchQuery) {
    const query = args.searchQuery.toLowerCase();
    tasks = tasks.filter((task: any) =>
      task.title?.toLowerCase().includes(query) ||
      task.description?.toLowerCase().includes(query)
    );
  }

  if (args.dateRange) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    tasks = tasks.filter((task: any) => {
      const createdAt = new Date(task.createdAt);
      switch (args.dateRange) {
        case "today":
          return createdAt >= today;
        case "thisWeek":
          return createdAt >= startOfWeek;
        case "thisMonth":
          return createdAt >= startOfMonth;
        default:
          return true;
      }
    });
  }

  if (args.tag) {
    tasks = tasks.filter((task: any) => {
      if (!task.meta) return false;
      const meta = typeof task.meta === 'string' ? JSON.parse(task.meta) : task.meta;
      return Object.values(meta).some((v: any) =>
        String(v).toLowerCase().includes(args.tag!.toLowerCase())
      );
    });
  }

  const lightweightTasks = tasks.map(({ comments, subtasks, ...task }: any) => task);
  return jsonToolResult(lightweightTasks);
});

server.registerTool("get_task", {
  description: "获取单个任务的详细信息",
  inputSchema: z.object({
    id: z.string().describe("任务ID"),
  }),
}, async ({ id }) => {
  const task = await apiGet<any>(`/api/tasks/${id}`);
  if (!task || task.error) {
    return createToolResult("Task not found", true);
  }
  return jsonToolResult(task);
});

server.registerTool("create_task", {
  description: "创建新任务",
  inputSchema: z.object({
    title: z.string().describe("任务标题"),
    description: z.string().optional().describe("任务描述"),
    columnId: z.string().optional().describe("列ID"),
    status: StatusEnum.optional().describe("任务状态，与columnId二选一"),
    priority: PriorityEnum.optional().describe("优先级"),
    assignee: z.string().optional().describe("负责人"),
    meta: z.record(z.string(), z.string()).optional().describe("元信息键值对"),
    published: z.boolean().optional().describe("是否发布到看板"),
    boardId: z.string().optional().describe("看板ID"),
  }),
}, async (args) => {
  const boardId = args.boardId;
  const url = boardId ? `/api/columns?boardId=${boardId}` : "/api/columns";
  const columns = await apiGet<any[]>(url);

  let columnId = args.columnId;

  if (!columnId && args.status) {
    const statusMap: Record<string, string> = {
      "todo": "待办",
      "in_progress": "进行中",
      "review": "待审核",
      "done": "已完成",
    };
    const columnName = statusMap[args.status];
    if (columnName) {
      const col = columns.find((c: any) => c.name === columnName);
      if (col) {
        columnId = col.id;
      }
    }
  }

  if (!columnId && columns.length > 0) {
    columnId = columns[0].id;
  }

  const task = await apiPost<any>("/api/tasks", {
    title: args.title,
    description: args.description,
    columnId,
    priority: args.priority || "medium",
    assignee: args.assignee,
    meta: args.meta,
    published: args.published ?? false,
    position: 9999,
  });
  broadcast();
  return jsonToolResult(task);
});

server.registerTool("update_task", {
  description: "更新任务",
  inputSchema: z.object({
    id: z.string().describe("任务ID"),
    title: z.string().optional().describe("新标题"),
    description: z.string().optional().describe("新描述"),
    priority: PriorityEnum.optional().describe("新优先级"),
    assignee: z.string().optional().describe("新负责人"),
    meta: z.record(z.string(), z.string()).optional().describe("元信息"),
    columnId: z.string().optional().describe("新列ID"),
    status: StatusEnum.optional().describe("新状态"),
  }),
}, async (args) => {
  const currentTask = await apiGet<any>(`/api/tasks/${args.id}`);
  if (!currentTask || currentTask.error) {
    return createToolResult("Task not found", true);
  }

  let columnId = args.columnId;

  if (!columnId && args.status) {
    const allColumns = await apiGet<any[]>("/api/columns");
    const currentColumn = allColumns.find((c: any) => c.id === currentTask.columnId);
    const currentBoardId = currentColumn?.boardId;

    if (currentBoardId) {
      const boardColumns = allColumns.filter((c: any) => c.boardId === currentBoardId);
      const statusMap: Record<string, string> = {
        "todo": "待办",
        "in_progress": "进行中",
        "testing": "待测试",
        "review": "待审核",
        "done": "已完成",
      };
      const columnName = statusMap[args.status];
      if (columnName) {
        const col = boardColumns.find((c: any) => c.name === columnName);
        if (col) {
          columnId = col.id;
        }
      }
    }
  }

  if (columnId && columnId === currentTask.columnId) {
    return createToolResult("任务已经在当前状态，无需修改", true);
  }

  const updateData: any = {};
  if (args.title !== undefined) updateData.title = args.title;
  if (args.description !== undefined) updateData.description = args.description;
  if (args.priority !== undefined) updateData.priority = args.priority;
  if (args.assignee !== undefined) updateData.assignee = args.assignee;
  if (args.meta !== undefined) updateData.meta = args.meta;
  if (columnId !== undefined) updateData.columnId = columnId;

  const task = await apiPut<any>(`/api/tasks/${args.id}`, updateData);
  broadcast();
  return jsonToolResult(task);
});

server.registerTool("delete_task", {
  description: "删除任务",
  inputSchema: z.object({
    id: z.string().describe("任务ID"),
  }),
}, async ({ id }) => {
  await apiDelete(`/api/tasks/${id}`);
  broadcast();
  return createToolResult("Task deleted successfully");
});

server.registerTool("list_drafts", {
  description: "列出所有草稿",
  inputSchema: z.object({
    boardId: z.string().optional().describe("看板ID"),
  }),
}, async ({ boardId }) => {
  const url = boardId ? `/api/drafts?boardId=${boardId}` : "/api/drafts";
  const drafts = await apiGet<any[]>(url);
  return jsonToolResult(drafts);
});

server.registerTool("publish_task", {
  description: "发布或取消发布任务",
  inputSchema: z.object({
    id: z.string().describe("任务ID"),
    published: z.boolean().describe("true=发布, false=取消发布"),
  }),
}, async ({ id, published }) => {
  const task = await apiPut<any>(`/api/tasks/${id}`, { published });
  broadcast();
  return jsonToolResult(task);
});

server.registerTool("list_archived_tasks", {
  description: "列出所有已归档的任务",
  inputSchema: z.object({
    boardId: z.string().optional().describe("看板ID"),
  }),
}, async ({ boardId }) => {
  const url = boardId ? `/api/archived?boardId=${boardId}` : "/api/archived";
  const archived = await apiGet<any[]>(url);
  return jsonToolResult(archived);
});

server.registerTool("archive_task", {
  description: "归档或取消归档任务",
  inputSchema: z.object({
    id: z.string().describe("任务ID"),
    archived: z.boolean().describe("true=归档, false=恢复"),
  }),
}, async ({ id, archived }) => {
  const task = await apiPost<any>(`/api/tasks/${id}/archive`, { archived });
  broadcast();
  return jsonToolResult(task);
});

server.registerTool("add_comment", {
  description: "为任务添加评论",
  inputSchema: z.object({
    taskId: z.string().describe("任务ID"),
    content: z.string().describe("评论内容"),
    author: z.string().optional().describe("评论作者"),
  }),
}, async (args) => {
  const comment = await apiPost<any>("/api/comments", {
    taskId: args.taskId,
    content: args.content,
    author: args.author || "Anonymous",
  });
  broadcast();
  return jsonToolResult(comment);
});

server.registerTool("list_comments", {
  description: "列出任务的评论",
  inputSchema: z.object({
    taskId: z.string().describe("任务ID"),
  }),
}, async ({ taskId }) => {
  const task = await apiGet<any>(`/api/tasks/${taskId}`);
  const comments = task?.comments || [];
  return jsonToolResult(comments);
});

server.registerTool("list_subtasks", {
  description: "列出任务的子任务",
  inputSchema: z.object({
    taskId: z.string().describe("任务ID"),
  }),
}, async ({ taskId }) => {
  const subtasks = await apiGet<any[]>(`/api/subtasks?taskId=${taskId}`);
  return jsonToolResult(subtasks);
});

server.registerTool("create_subtask", {
  description: "创建子任务",
  inputSchema: z.object({
    taskId: z.string().describe("父任务ID"),
    title: z.string().describe("子任务标题"),
  }),
}, async ({ taskId, title }) => {
  const subtask = await apiPost<any>("/api/subtasks", { taskId, title });
  broadcast();
  return jsonToolResult(subtask);
});

server.registerTool("update_subtask", {
  description: "更新子任务",
  inputSchema: z.object({
    id: z.string().describe("子任务ID"),
    title: z.string().optional().describe("新标题"),
    completed: z.boolean().optional().describe("是否完成"),
  }),
}, async (args) => {
  const subtask = await apiPut<any>(`/api/subtasks/${args.id}`, {
    title: args.title,
    completed: args.completed,
  });
  broadcast();
  return jsonToolResult(subtask);
});

server.registerTool("delete_subtask", {
  description: "删除子任务",
  inputSchema: z.object({
    id: z.string().describe("子任务ID"),
  }),
}, async ({ id }) => {
  await apiDelete(`/api/subtasks/${id}`);
  broadcast();
  return createToolResult("Subtask deleted successfully");
});

server.registerTool("get_dashboard_stats", {
  description: "获取看板统计信息",
  inputSchema: z.object({}),
}, async () => {
  const stats = await apiGet<any>("/api/dashboard/stats");
  return jsonToolResult(stats);
});

server.registerTool("complete_task", {
  description: "标记任务完成并自动流转到下一列",
  inputSchema: z.object({
    id: z.string().describe("任务ID"),
  }),
}, async ({ id }) => {
  const task = await apiPost<any>(`/api/tasks/${id}/complete`, {});
  broadcast();
  return jsonToolResult(task);
});

server.registerTool("list_my_tasks", {
  description: "获取当前Agent负责的任务",
  inputSchema: z.object({}),
}, async () => {
  const result = await apiGet<any>(`/api/mcp/my-tasks`);
  return jsonToolResult(result);
});

const transport = new StdioServerTransport();
await server.connect(transport);
