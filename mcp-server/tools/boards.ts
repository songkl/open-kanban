import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { apiGet, jsonToolResult, API_BASE } from "./helpers.js";

export function get_status(srv: McpServer) {
  srv.registerTool("get_status", {
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
}

export function list_boards(srv: McpServer) {
  srv.registerTool("list_boards", {
    description: "列出所有看板（只读）",
    inputSchema: z.object({}),
  }, async () => {
    const boards = await apiGet<any[]>("/api/boards");
    const result = boards.map(({ _count, ...board }) => board);
    return jsonToolResult(result);
  });
}

export function get_board(srv: McpServer) {
  srv.registerTool("get_board", {
    description: "获取单个看板的详细信息，包括描述",
    inputSchema: z.object({
      boardId: z.string().describe("看板ID"),
    }),
  }, async ({ boardId }) => {
    const board = await apiGet<any>(`/api/boards/${boardId}`);
    if (!board || board.error) {
      return { content: [{ type: "text" as const, text: "Board not found" }], isError: true };
    }
    const { _count, ...rest } = board;
    return jsonToolResult(rest);
  });
}
