import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { apiGet, jsonToolResult } from "./helpers.js";

export function get_dashboard_stats(srv: McpServer) {
  srv.registerTool("get_dashboard_stats", {
    description: "获取看板统计信息",
    inputSchema: z.object({}),
  }, async () => {
    const stats = await apiGet<any>("/api/v1/dashboard/stats");
    return jsonToolResult(stats);
  });
}
