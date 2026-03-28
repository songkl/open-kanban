import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Configure the API base URL - can be overridden via environment variable
const API_BASE = process.env.KANBAN_API_URL || "http://localhost:3000";
const MCP_TOKEN = process.env.KANBAN_MCP_TOKEN; // Token for MCP authentication

// HTTP helper functions
async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: MCP_TOKEN ? { "Authorization": `Bearer ${MCP_TOKEN}` } : {},
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
    headers: MCP_TOKEN ? { "Authorization": `Bearer ${MCP_TOKEN}` } : {},
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
}

// Broadcast changes to connected clients
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

const server = new Server(
  {
    name: "kanban-mcp-server",
    version: "1.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_status",
        description: "获取看板服务状态",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_boards",
        description: "列出所有看板（只读）",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_columns",
        description: "列出看板的列",
        inputSchema: {
          type: "object",
          properties: {
            boardId: {
              type: "string",
              description: "看板ID，不填则使用第一个看板",
            },
          },
        },
      },
      {
        name: "list_tasks",
        description: "列出所有任务或指定列的任务，可按 Agent 类型筛选（需要设置 KANBAN_MCP_TOKEN 环境变量）",
        inputSchema: {
          type: "object",
          properties: {
            boardId: {
              type: "string",
              description: "看板ID，不填则使用第一个看板",
            },
            columnId: {
              type: "string",
              description: "可选：列ID，列出该列的所有任务",
            },
            status: {
              type: "string",
              enum: ["todo", "in_progress", "review", "done"],
              description: "可选：按状态筛选 (todo=待办, in_progress=进行中, review=待审核, done=已完成)",
            },
            agentType: {
              type: "string",
              description: "可选：按 Agent 类型筛选，只返回该类型 Agent 可以处理的任务",
            },
          },
        },
      },
      {
        name: "get_task",
        description: "获取单个任务的详细信息",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "任务ID",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "create_task",
        description: "创建新任务（需要设置 KANBAN_MCP_TOKEN 环境变量）",
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "任务标题",
            },
            description: {
              type: "string",
              description: "任务描述（可选）",
            },
            columnId: {
              type: "string",
              description: "所属列ID",
            },
            status: {
              type: "string",
              enum: ["todo", "in_progress", "review", "done"],
              description: "任务状态（与columnId二选一，todo=待办, in_progress=进行中, review=待审核, done=已完成）",
            },
            priority: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "优先级",
            },
            assignee: {
              type: "string",
              description: "负责人（可选）",
            },
            meta: {
              type: "object",
              description: "元信息键值对，如 { \"标签\": \"bug\", \"预估工时\": \"4h\" }",
            },
            published: {
              type: "boolean",
              description: "是否发布到看板（默认 false，即保存为草稿）",
            },
          },
          required: ["title"],
        },
      },
      {
        name: "update_task",
        description: "更新任务",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "任务ID",
            },
            title: {
              type: "string",
              description: "新标题",
            },
            description: {
              type: "string",
              description: "新描述",
            },
            priority: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "新优先级",
            },
            assignee: {
              type: "string",
              description: "新负责人",
            },
            meta: {
              type: "object",
              description: "元信息键值对，如 { \"标签\": \"bug\", \"预估工时\": \"4h\" }",
            },
            columnId: {
              type: "string",
              description: "新列ID（移动任务）",
            },
            status: {
              type: "string",
              enum: ["todo", "in_progress", "review", "done"],
              description: "任务状态（与columnId二选一）",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "delete_task",
        description: "删除任务",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "任务ID",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "list_drafts",
        description: "列出所有草稿（未发布的任务）",
        inputSchema: {
          type: "object",
          properties: {
            boardId: {
              type: "string",
              description: "看板ID，不填则使用第一个看板",
            },
          },
        },
      },
      {
        name: "publish_task",
        description: "发布或取消发布任务",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "任务ID",
            },
            published: {
              type: "boolean",
              description: "true=发布任务到看板, false=取消发布（转为草稿）",
            },
          },
          required: ["id", "published"],
        },
      },
      {
        name: "list_archived_tasks",
        description: "列出所有已归档的任务",
        inputSchema: {
          type: "object",
          properties: {
            boardId: {
              type: "string",
              description: "看板ID，不填则使用第一个看板",
            },
          },
        },
      },
      {
        name: "archive_task",
        description: "归档或取消归档任务",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "任务ID",
            },
            archived: {
              type: "boolean",
              description: "true=归档任务, false=恢复任务",
            },
          },
          required: ["id", "archived"],
        },
      },
      {
        name: "add_comment",
        description: "为任务添加评论",
        inputSchema: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "任务ID",
            },
            content: {
              type: "string",
              description: "评论内容",
            },
            author: {
              type: "string",
              description: "评论作者",
            },
          },
          required: ["taskId", "content"],
        },
      },
      {
        name: "list_comments",
        description: "列出任务的评论",
        inputSchema: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "任务ID",
            },
          },
          required: ["taskId"],
        },
      },
      {
        name: "list_subtasks",
        description: "列出任务的子任务",
        inputSchema: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "任务ID",
            },
          },
          required: ["taskId"],
        },
      },
      {
        name: "create_subtask",
        description: "创建子任务",
        inputSchema: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "父任务ID",
            },
            title: {
              type: "string",
              description: "子任务标题",
            },
          },
          required: ["taskId", "title"],
        },
      },
      {
        name: "update_subtask",
        description: "更新子任务（标记完成/未完成）",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "子任务ID",
            },
            title: {
              type: "string",
              description: "新标题（可选）",
            },
            completed: {
              type: "boolean",
              description: "是否完成",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "delete_subtask",
        description: "删除子任务",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "子任务ID",
            },
          },
          required: ["id"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "get_status": {
        try {
          // Check API health
          const start = Date.now();
          await fetch(`${API_BASE}/api/boards`);
          const latency = Date.now() - start;
          
          // Get board count
          const boards = await apiGet<any[]>("/api/boards");
          
          const status = {
            status: "online",
            apiUrl: API_BASE,
            latencyMs: latency,
            boardsCount: boards.length,
            timestamp: new Date().toISOString(),
          };
          return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
        } catch (error: any) {
          const status = {
            status: "offline",
            apiUrl: API_BASE,
            error: error.message,
            timestamp: new Date().toISOString(),
          };
          return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
        }
      }

      case "list_boards": {
        const boards = await apiGet<any[]>("/api/boards");
        // Remove _count from response
        const result = boards.map(({ _count, ...board }) => board);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "list_columns": {
        const boardId = args.boardId as string | undefined;
        const url = boardId ? `/api/columns?boardId=${boardId}` : "/api/columns";
        const columns = await apiGet<any[]>(url);
        // Extract just column info without tasks
        const result = columns.map(({ tasks, ...col }) => col);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "list_tasks": {
        // First get all columns to map status to columnId
        const boardId = args.boardId as string | undefined;
        const url = boardId ? `/api/columns?boardId=${boardId}` : "/api/columns";
        const columns = await apiGet<any[]>(url);
        
        let columnId = args.columnId as string | undefined;
        
        if (args.status && !columnId) {
          const statusMap: Record<string, string> = {
            "todo": "待办",
            "in_progress": "进行中",
            "review": "待审核",
            "done": "已完成",
          };
          const columnName = statusMap[args.status as string];
          if (columnName) {
            const col = columns.find((c: any) => c.name === columnName);
            if (col) {
              columnId = col.id;
            }
          }
        }

        // Filter tasks based on columnId
        let tasks: any[] = [];
        if (columnId) {
          const col = columns.find((c: any) => c.id === columnId);
          tasks = col?.tasks || [];
        } else {
          // Get all tasks from all columns
          tasks = columns.flatMap((c: any) => c.tasks || []);
        }

        // Filter by agentType if provided
        if (args.agentType) {
          const agentType = args.agentType as string;
          tasks = tasks.filter((task: any) => {
            // Check if the column has agent config that allows this agent type
            const col = columns.find((c: any) => c.id === task.columnId);
            if (!col?.agentConfig) return false; // No config = not assignable to agents
            
            try {
              const allowedTypes = JSON.parse(col.agentConfig);
              return allowedTypes.includes(agentType);
            } catch {
              return false;
            }
          });
        }
        
        return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] };
      }

      case "get_task": {
        const task = await apiGet<any>(`/api/tasks/${args.id}`);
        if (!task || task.error) {
          return { content: [{ type: "text", text: "Task not found" }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
      }

      case "create_task": {
        // Get columns to find columnId from status
        const boardId = args.boardId as string | undefined;
        const url = boardId ? `/api/columns?boardId=${boardId}` : "/api/columns";
        const columns = await apiGet<any[]>(url);
        
        let columnId = args.columnId as string | undefined;
        
        if (!columnId && args.status) {
          const statusMap: Record<string, string> = {
            "todo": "待办",
            "in_progress": "进行中",
            "review": "待审核",
            "done": "已完成",
          };
          const columnName = statusMap[args.status as string];
          if (columnName) {
            const col = columns.find((c: any) => c.name === columnName);
            if (col) {
              columnId = col.id;
            }
          }
        }

        // If still no columnId, use first column (待办)
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
        return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
      }

      case "update_task": {
        // Get current task first
        const currentTask = await apiGet<any>(`/api/tasks/${args.id}`);
        if (!currentTask || currentTask.error) {
          return { content: [{ type: "text", text: "Task not found" }], isError: true };
        }

        // If columnId is provided directly, only allow if it's in the SAME board
        let columnId = args.columnId as string | undefined;
        
        // If status is provided, find the column by status within the CURRENT board only
        if (!columnId && args.status) {
          const allColumns = await apiGet<any[]>("/api/columns");
          
          // Find current task's column to get its board
          const currentColumn = allColumns.find((c: any) => c.id === currentTask.columnId);
          const currentBoardId = currentColumn?.boardId;
          
          if (currentBoardId) {
            // Only search columns within the same board
            const boardColumns = allColumns.filter((c: any) => c.boardId === currentBoardId);
            const statusMap: Record<string, string> = {
              "todo": "待办",
              "in_progress": "进行中",
              "testing": "待测试",
              "review": "待审核",
              "done": "已完成",
            };
            const columnName = statusMap[args.status as string];
            if (columnName) {
              const col = boardColumns.find((c: any) => c.name === columnName);
              if (col) {
                columnId = col.id;
              }
            }
          }
        }

        // Check if trying to move to same column
        if (columnId && columnId === currentTask.columnId) {
          return { 
            content: [{ 
              type: "text", 
              text: `任务已经在当前状态，无需修改` 
            }], 
            isError: true 
          };
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
        return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
      }

      case "delete_task": {
        await apiDelete(`/api/tasks/${args.id}`);
        broadcast();
        return { content: [{ type: "text", text: "Task deleted successfully" }] };
      }

      case "add_comment": {
        const comment = await apiPost<any>("/api/comments", {
          taskId: args.taskId,
          content: args.content,
          author: args.author || "Anonymous",
        });
        broadcast();
        return { content: [{ type: "text", text: JSON.stringify(comment, null, 2) }] };
      }

      case "list_comments": {
        const task = await apiGet<any>(`/api/tasks/${args.taskId}`);
        const comments = task?.comments || [];
        return { content: [{ type: "text", text: JSON.stringify(comments, null, 2) }] };
      }

      case "list_drafts": {
        const boardId = args.boardId as string | undefined;
        const url = boardId ? `/api/drafts?boardId=${boardId}` : "/api/drafts";
        const drafts = await apiGet<any[]>(url);
        return { content: [{ type: "text", text: JSON.stringify(drafts, null, 2) }] };
      }

      case "list_archived_tasks": {
        const boardId = args.boardId as string | undefined;
        const url = boardId ? `/api/archived?boardId=${boardId}` : "/api/archived";
        const archived = await apiGet<any[]>(url);
        return { content: [{ type: "text", text: JSON.stringify(archived, null, 2) }] };
      }

      case "publish_task": {
        const task = await apiPut<any>(`/api/tasks/${args.id}`, {
          published: args.published,
        });
        broadcast();
        return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
      }

      case "archive_task": {
        const task = await apiPost<any>(`/api/tasks/${args.id}/archive`, {
          archived: args.archived,
        });
        broadcast();
        return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
      }

      case "list_subtasks": {
        const subtasks = await apiGet<any[]>(`/api/subtasks?taskId=${args.taskId}`);
        return { content: [{ type: "text", text: JSON.stringify(subtasks, null, 2) }] };
      }

      case "create_subtask": {
        const subtask = await apiPost<any>("/api/subtasks", {
          taskId: args.taskId,
          title: args.title,
        });
        broadcast();
        return { content: [{ type: "text", text: JSON.stringify(subtask, null, 2) }] };
      }

      case "update_subtask": {
        const subtask = await apiPut<any>(`/api/subtasks/${args.id}`, {
          title: args.title,
          completed: args.completed,
        });
        broadcast();
        return { content: [{ type: "text", text: JSON.stringify(subtask, null, 2) }] };
      }

      case "delete_subtask": {
        await apiDelete(`/api/subtasks/${args.id}`);
        broadcast();
        return { content: [{ type: "text", text: "Subtask deleted successfully" }] };
      }

      default:
        return { content: [{ type: "text", text: "Unknown tool" }], isError: true };
    }
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: ${error.message || error}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
