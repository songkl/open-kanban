import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { get_status } from "./tools/boards.js";
import { list_boards, get_board } from "./tools/boards.js";
import { list_columns, get_column } from "./tools/columns.js";
import { list_tasks, get_task, create_task, update_task, delete_task, complete_task } from "./tools/tasks.js";
import { list_drafts, publish_task } from "./tools/drafts.js";
import { list_archived_tasks, archive_task } from "./tools/archive.js";
import { add_comment, list_comments } from "./tools/comments.js";
import { list_subtasks, create_subtask, update_subtask, delete_subtask } from "./tools/subtasks.js";
import { get_dashboard_stats } from "./tools/stats.js";
import { list_my_tasks } from "./tools/mytasks.js";

const server = new McpServer({
  name: "kanban-mcp-server",
  version: "1.3.0",
});

export function registerTools(srv: McpServer) {
  get_status(srv);
  list_boards(srv);
  get_board(srv);
  list_columns(srv);
  get_column(srv);
  list_tasks(srv);
  get_task(srv);
  create_task(srv);
  update_task(srv);
  delete_task(srv);
  complete_task(srv);
  list_drafts(srv);
  publish_task(srv);
  list_archived_tasks(srv);
  archive_task(srv);
  add_comment(srv);
  list_comments(srv);
  list_subtasks(srv);
  create_subtask(srv);
  update_subtask(srv);
  delete_subtask(srv);
  get_dashboard_stats(srv);
  list_my_tasks(srv);
}

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
