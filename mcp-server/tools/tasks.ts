import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { apiGet, apiPost, apiPut, broadcast, createToolResult, jsonToolResult } from "./helpers.js";
import { StatusEnum, PriorityEnum, DateRangeEnum } from "./types.js";

export function list_tasks(srv: McpServer) {
  srv.registerTool("list_tasks", {
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
    const url = boardId ? `/api/v1/columns?boardId=${boardId}` : "/api/v1/columns";
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
        let meta: any;
        try {
          meta = typeof task.meta === 'string' ? JSON.parse(task.meta) : task.meta;
        } catch {
          return false;
        }
        return Object.values(meta).some((v: any) =>
          String(v).toLowerCase().includes(args.tag!.toLowerCase())
        );
      });
    }

    const lightweightTasks = tasks.map(({ comments, subtasks, ...task }: any) => task);
    return jsonToolResult(lightweightTasks);
  });
}

export function get_task(srv: McpServer) {
  srv.registerTool("get_task", {
    description: "获取单个任务的详细信息",
    inputSchema: z.object({
      id: z.string().describe("任务ID"),
    }),
  }, async ({ id }) => {
    const task = await apiGet<any>(`/api/v1/tasks/${id}`);
    if (!task || task.error) {
      return createToolResult("Task not found", true);
    }
    return jsonToolResult(task);
  });
}

export function create_task(srv: McpServer) {
  srv.registerTool("create_task", {
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
    const url = boardId ? `/api/v1/columns?boardId=${boardId}` : "/api/v1/columns";
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

    const task = await apiPost<any>("/api/v1/tasks", {
      title: args.title,
      description: args.description,
      columnId,
      priority: args.priority || "medium",
      assignee: args.assignee,
      meta: args.meta,
      published: args.published ?? true,
      position: 9999,
    });
    broadcast();
    return jsonToolResult(task);
  });
}

export function update_task(srv: McpServer) {
  srv.registerTool("update_task", {
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
    const currentTask = await apiGet<any>(`/api/v1/tasks/${args.id}`);
    if (!currentTask || currentTask.error) {
      return createToolResult("Task not found", true);
    }

    let columnId = args.columnId;

    if (!columnId && args.status) {
        const allColumns = await apiGet<any[]>("/api/v1/columns");
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

    const task = await apiPut<any>(`/api/v1/tasks/${args.id}`, updateData);
    broadcast();
    return jsonToolResult(task);
  });
}

export function delete_task(srv: McpServer) {
  srv.registerTool("delete_task", {
    description: "删除任务",
    inputSchema: z.object({
      id: z.string().describe("任务ID"),
    }),
  }, async ({ id }) => {
    const { apiDelete } = await import("./helpers.js");
    await apiDelete(`/api/v1/tasks/${id}`);
    broadcast();
    return createToolResult("Task deleted successfully");
  });
}

export function complete_task(srv: McpServer) {
  srv.registerTool("complete_task", {
    description: "标记任务完成并自动流转到下一列",
    inputSchema: z.object({
      id: z.string().describe("任务ID"),
    }),
  }, async ({ id }) => {
    const task = await apiPost<any>(`/api/v1/tasks/${id}/complete`, {});
    broadcast();
    return jsonToolResult(task);
  });
}

export function batch_update_tasks(srv: McpServer) {
  srv.registerTool("batch_update_tasks", {
    description: "批量更新任务状态或移动任务到指定列",
    inputSchema: z.object({
      ids: z.array(z.string()).describe("任务ID列表"),
      columnId: z.string().optional().describe("目标列ID，与status二选一"),
      status: StatusEnum.optional().describe("目标状态，与columnId二选一"),
      priority: PriorityEnum.optional().describe("新优先级"),
      assignee: z.string().optional().describe("新负责人"),
    }),
  }, async (args) => {
    if (!args.columnId && !args.status && !args.priority && !args.assignee) {
      return createToolResult("at least one update field is required (columnId, status, priority, or assignee)", true);
    }

    let columnId = args.columnId;

    if (!columnId && args.status) {
      const allColumns = await apiGet<any[]>("/api/v1/columns");
      const statusMap: Record<string, string> = {
        "todo": "待办",
        "in_progress": "进行中",
        "testing": "待测试",
        "review": "待审核",
        "done": "已完成",
      };
      const columnName = statusMap[args.status];
      if (columnName) {
        const col = allColumns.find((c: any) => c.name === columnName);
        if (col) {
          columnId = col.id;
        }
      }
    }

    const updateData: any = {};
    if (columnId) updateData.columnId = columnId;
    if (args.priority) updateData.priority = args.priority;
    if (args.assignee) updateData.assignee = args.assignee;

    const result = await apiPut<any>("/api/v1/tasks/batch", {
      ids: args.ids,
      ...updateData,
    });
    broadcast();
    return jsonToolResult(result);
  });
}

export function batch_delete_tasks(srv: McpServer) {
  srv.registerTool("batch_delete_tasks", {
    description: "批量删除任务",
    inputSchema: z.object({
      ids: z.array(z.string()).describe("任务ID列表"),
    }),
  }, async (args) => {
    if (!args.ids || args.ids.length === 0) {
      return createToolResult("at least one task id is required", true);
    }

    const { apiDeleteWithResult } = await import("./helpers.js");
    const result = await apiDeleteWithResult<any>("/api/v1/tasks/batch", { ids: args.ids });
    broadcast();
    return jsonToolResult(result);
  });
}

export function batch_create_tasks(srv: McpServer) {
  srv.registerTool("batch_create_tasks", {
    description: "批量创建任务",
    inputSchema: z.object({
      tasks: z.array(z.object({
        title: z.string().describe("任务标题"),
        description: z.string().optional().describe("任务描述"),
        columnId: z.string().describe("所属列ID"),
        priority: PriorityEnum.optional().describe("优先级 (low/medium/high)"),
        assignee: z.string().optional().describe("负责人"),
        published: z.boolean().optional().describe("是否发布到看板，默认 true"),
      })).describe("任务列表"),
    }),
  }, async (args) => {
    if (!args.tasks || args.tasks.length === 0) {
      return createToolResult("at least one task is required", true);
    }

    const tasks = args.tasks.map(t => ({
      title: t.title,
      description: t.description,
      columnId: t.columnId,
      priority: t.priority || "medium",
      assignee: t.assignee,
      published: t.published !== false,
    }));

    const result = await apiPost<any>("/api/v1/tasks/batch", { tasks });
    broadcast();
    return jsonToolResult(result);
  });
}
