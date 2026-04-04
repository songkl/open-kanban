import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { apiGet, jsonToolResult } from "./helpers.js";

export function list_my_tasks(srv: McpServer) {
  srv.registerTool("list_my_tasks", {
    description: "获取当前Agent负责的任务",
    inputSchema: z.object({}),
  }, async () => {
    const result = await apiGet<any>(`/api/mcp/my-tasks`);
    return jsonToolResult(result);
  });
}
