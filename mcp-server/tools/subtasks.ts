import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { apiGet, apiPost, apiPut, apiDelete, broadcast, createToolResult, jsonToolResult } from "./helpers.js";

export function list_subtasks(srv: McpServer) {
  srv.registerTool("list_subtasks", {
    description: "列出任务的子任务",
    inputSchema: z.object({
      taskId: z.string().describe("任务ID"),
    }),
  }, async ({ taskId }) => {
    const subtasks = await apiGet<any[]>(`/api/subtasks?taskId=${taskId}`);
    return jsonToolResult(subtasks);
  });
}

export function create_subtask(srv: McpServer) {
  srv.registerTool("create_subtask", {
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
}

export function update_subtask(srv: McpServer) {
  srv.registerTool("update_subtask", {
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
}

export function delete_subtask(srv: McpServer) {
  srv.registerTool("delete_subtask", {
    description: "删除子任务",
    inputSchema: z.object({
      id: z.string().describe("子任务ID"),
    }),
  }, async ({ id }) => {
    await apiDelete(`/api/subtasks/${id}`);
    broadcast();
    return createToolResult("Subtask deleted successfully");
  });
}
