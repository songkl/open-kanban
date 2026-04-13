import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { apiGet, apiPost, broadcast, createToolResult, jsonToolResult } from "./helpers.js";

export function upload_file(srv: McpServer) {
  srv.registerTool("upload_file", {
    description: "上传文本文件到工作区",
    inputSchema: z.object({
      path: z.string().describe("文件路径（相对于工作区）"),
      content: z.string().describe("文件内容"),
    }),
  }, async (args) => {
    try {
      const result = await apiPost<any>("/api/v1/workspace/upload", {
        path: args.path,
        content: args.content,
      });
      return jsonToolResult(result);
    } catch (error: any) {
      return createToolResult(`上传失败: ${error.message}`, true);
    }
  });
}

export function batch_upload_files(srv: McpServer) {
  srv.registerTool("batch_upload_files", {
    description: "批量上传文本文件到工作区",
    inputSchema: z.object({
      files: z.array(z.object({
        path: z.string().describe("文件路径（相对于工作区）"),
        content: z.string().describe("文件内容"),
      })).describe("文件列表"),
    }),
  }, async (args) => {
    try {
      const result = await apiPost<any>("/api/v1/workspace/batch-upload", {
        files: args.files,
      });
      return jsonToolResult(result);
    } catch (error: any) {
      return createToolResult(`批量上传失败: ${error.message}`, true);
    }
  });
}

export function list_workspace_files(srv: McpServer) {
  srv.registerTool("list_workspace_files", {
    description: "列出工作区文件",
    inputSchema: z.object({
      path: z.string().optional().describe("子目录路径（可选）"),
    }),
  }, async (args) => {
    try {
      const url = args.path ? `/api/v1/workspace/files?path=${encodeURIComponent(args.path)}` : "/api/v1/workspace/files";
      const result = await apiGet<any>(url);
      return jsonToolResult(result);
    } catch (error: any) {
      return createToolResult(`列出文件失败: ${error.message}`, true);
    }
  });
}

export function read_workspace_file(srv: McpServer) {
  srv.registerTool("read_workspace_file", {
    description: "读取工作区文件内容",
    inputSchema: z.object({
      path: z.string().describe("文件路径（相对于工作区）"),
    }),
  }, async (args) => {
    try {
      const result = await apiGet<any>(`/api/v1/workspace/files/${encodeURIComponent(args.path)}`);
      return jsonToolResult(result);
    } catch (error: any) {
      return createToolResult(`读取文件失败: ${error.message}`, true);
    }
  });
}

export function delete_workspace_file(srv: McpServer) {
  srv.registerTool("delete_workspace_file", {
    description: "删除工作区文件",
    inputSchema: z.object({
      path: z.string().describe("文件路径（相对于工作区）"),
    }),
  }, async (args) => {
    try {
      const { apiDelete } = await import("./helpers.js");
      await apiDelete(`/api/v1/workspace/files/${encodeURIComponent(args.path)}`);
      return createToolResult("文件删除成功");
    } catch (error: any) {
      return createToolResult(`删除文件失败: ${error.message}`, true);
    }
  });
}

export function workspace_stats(srv: McpServer) {
  srv.registerTool("workspace_stats", {
    description: "获取工作区统计信息",
    inputSchema: z.object({}),
  }, async () => {
    try {
      const result = await apiGet<any>("/api/v1/workspace/stats");
      return jsonToolResult(result);
    } catch (error: any) {
      return createToolResult(`获取统计失败: ${error.message}`, true);
    }
  });
}