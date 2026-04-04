import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { apiGet, createToolResult, jsonToolResult } from "./helpers.js";

export function list_columns(srv: McpServer) {
  srv.registerTool("list_columns", {
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
}

export function get_column(srv: McpServer) {
  srv.registerTool("get_column", {
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
}
