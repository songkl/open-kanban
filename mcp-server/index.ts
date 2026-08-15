import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { get_status } from "./tools/boards.js";
import { list_boards, get_board } from "./tools/boards.js";
import { list_columns, get_column } from "./tools/columns.js";
import { list_tasks, get_task, create_task, update_task, delete_task, complete_task, batch_update_tasks, batch_delete_tasks, batch_create_tasks } from "./tools/tasks.js";
import { list_drafts, publish_task } from "./tools/drafts.js";
import { list_archived_tasks, archive_task } from "./tools/archive.js";
import { add_comment, list_comments } from "./tools/comments.js";
import { list_subtasks, create_subtask, update_subtask, delete_subtask } from "./tools/subtasks.js";
import { get_dashboard_stats } from "./tools/stats.js";
import { list_my_tasks } from "./tools/mytasks.js";
import { upload_file, batch_upload_files, list_workspace_files, read_workspace_file, delete_workspace_file, workspace_stats } from "./tools/upload.js";
import { setOAuthClient } from "./tools/helpers.js";
import { OAuthClient } from "./src/auth/client.js";

const server = new McpServer({
  name: "kanban-mcp-server",
  version: "2.0.0",
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
  batch_update_tasks(srv);
  batch_delete_tasks(srv);
  batch_create_tasks(srv);
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
  upload_file(srv);
  batch_upload_files(srv);
  list_workspace_files(srv);
  read_workspace_file(srv);
  delete_workspace_file(srv);
  workspace_stats(srv);
}

registerTools(server);

// --- OAuth 2.1 bootstrap ----------------------------------------------------
// Discovery + DCR + device flow happens synchronously on startup. We surface
// the user_code + verification_uri to stderr so the AI host (and the user)
// can see the prompt. When the env var KANBAN_MCP_TOKEN is set we skip the
// device flow and rely on the legacy bearer.
async function bootstrapAuth(): Promise<void> {
  const apiUrl = process.env.KANBAN_API_URL || "http://localhost:8080";
  if (process.env.KANBAN_MCP_TOKEN) {
    // Legacy mode: helpers.ts will pick up the token from env.
    return;
  }
  try {
    const client = await OAuthClient.fromConfig({ apiUrl });
    const creds = client.loadCredentials();
    if (creds?.accessToken || creds?.refreshToken) {
      setOAuthClient(client);
      return;
    }
    // Run the interactive device flow. The host will print stderr output to
    // the user via the MCP "logging" facility when wired up.
    await client.authorizeInteractive({
      apiUrl,
      onPrompt: async (poll) => {
        process.stderr.write(
          `\n[kanban-mcp] OAuth authorization required\n` +
            `  Visit: ${poll.verificationUri}\n` +
            `  Enter code: ${poll.userCode}\n` +
            `  Waiting for approval...\n`
        );
        // Approve is implicit: the MCP host cannot click buttons for the
        // user, so we just wait for the user to complete the browser flow.
        return "approve";
      }
    });
    setOAuthClient(client);
  } catch (err) {
    process.stderr.write(`[kanban-mcp] OAuth bootstrap failed: ${(err as Error).message}\n`);
  }
}

await bootstrapAuth();

const transport = new StdioServerTransport();
await server.connect(transport);