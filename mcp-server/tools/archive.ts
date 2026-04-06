import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { apiGet, apiPost, broadcast, jsonToolResult } from "./helpers.js";

export function list_archived_tasks(srv: McpServer) {
  srv.registerTool("list_archived_tasks", {
    description: "列出所有已归档的任务",
    inputSchema: z.object({
      boardId: z.string().optional().describe("看板ID"),
    }),
  }, async ({ boardId }) => {
    const url = boardId ? `/api/v1/archived?boardId=${boardId}` : "/api/v1/archived";
    const archived = await apiGet<any[]>(url);
    return jsonToolResult(archived);
  });
}

export function archive_task(srv: McpServer) {
  srv.registerTool("archive_task", {
    description: "归档或取消归档任务",
    inputSchema: z.object({
      id: z.string().describe("任务ID"),
      archived: z.boolean().describe("true=归档, false=恢复"),
    }),
  }, async ({ id, archived }) => {
    const task = await apiPost<any>(`/api/v1/tasks/${id}/archive`, { archived });
    broadcast();
    return jsonToolResult(task);
  });
}
