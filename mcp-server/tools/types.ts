import { z } from "zod/v4";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export { CallToolResult };
export { z };

export const StatusEnum = z.enum(["todo", "in_progress", "review", "done"]);
export const PriorityEnum = z.enum(["low", "medium", "high"]);
export const DateRangeEnum = z.enum(["today", "thisWeek", "thisMonth"]);

export type Status = "todo" | "in_progress" | "review" | "done";
export type Priority = "low" | "medium" | "high";
export type DateRange = "today" | "thisWeek" | "thisMonth";
