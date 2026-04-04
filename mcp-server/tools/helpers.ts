import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const API_BASE = process.env.KANBAN_API_URL || "http://localhost:8080";
const MCP_TOKEN = process.env.KANBAN_MCP_TOKEN;
const MCP_REQUEST_HEADER = "X-MCP-Request";
const BROADCAST_URL = process.env.BROADCAST_URL || "http://localhost:3001/broadcast";

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      ...(MCP_TOKEN ? { "Authorization": `Bearer ${MCP_TOKEN}` } : {}),
      [MCP_REQUEST_HEADER]: "true",
    },
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as any;
}

export async function apiPost<T>(path: string, body: any): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      ...(MCP_TOKEN ? { "Authorization": `Bearer ${MCP_TOKEN}` } : {}),
      [MCP_REQUEST_HEADER]: "true",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as any;
}

export async function apiPut<T>(path: string, body: any): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: { 
      "Content-Type": "application/json",
      ...(MCP_TOKEN ? { "Authorization": `Bearer ${MCP_TOKEN}` } : {}),
      [MCP_REQUEST_HEADER]: "true",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as any;
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers: {
      ...(MCP_TOKEN ? { "Authorization": `Bearer ${MCP_TOKEN}` } : {}),
      [MCP_REQUEST_HEADER]: "true",
    },
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
}

export async function broadcast() {
  try {
    await fetch(BROADCAST_URL, {
      method: "POST",
      body: JSON.stringify({ type: "refresh" }),
    });
  } catch (e) {
    // API server not running, ignore
  }
}

export function createToolResult(content: string, isError = false): CallToolResult {
  return { content: [{ type: "text" as const, text: content }], isError };
}

export function jsonToolResult(data: any): CallToolResult {
  return createToolResult(JSON.stringify(data, null, 2));
}

export { API_BASE };
