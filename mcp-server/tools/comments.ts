import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { apiGet, apiPost, broadcast, jsonToolResult } from "./helpers.js";

export function add_comment(srv: McpServer) {
  srv.registerTool("add_comment", {
    description: "为任务添加评论",
    inputSchema: z.object({
      taskId: z.string().describe("任务ID"),
      content: z.string().describe("评论内容"),
      author: z.string().optional().describe("评论作者"),
    }),
  }, async (args) => {
    const comment = await apiPost<any>("/api/v1/comments", {
      taskId: args.taskId,
      content: args.content,
      author: args.author || "Anonymous",
    });
    broadcast();
    return jsonToolResult(comment);
  });
}

export function list_comments(srv: McpServer) {
  srv.registerTool("list_comments", {
    description: "列出任务的评论",
    inputSchema: z.object({
      taskId: z.string().describe("任务ID"),
    }),
    }, async ({ taskId }) => {
    const task = await apiGet<any>(`/api/v1/tasks/${taskId}?include=comments`);
    const comments = task?.comments || [];
    const comments = task?.comments || [];
    return jsonToolResult(comments);
  });
}
