import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { apiGet, apiPut, broadcast, jsonToolResult } from "./helpers.js";

export function list_drafts(srv: McpServer) {
  srv.registerTool("list_drafts", {
    description: "列出所有草稿",
    inputSchema: z.object({
      boardId: z.string().optional().describe("看板ID"),
    }),
  }, async ({ boardId }) => {
    const url = boardId ? `/api/drafts?boardId=${boardId}` : "/api/drafts";
    const drafts = await apiGet<any[]>(url);
    return jsonToolResult(drafts);
  });
}

export function publish_task(srv: McpServer) {
  srv.registerTool("publish_task", {
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
}
