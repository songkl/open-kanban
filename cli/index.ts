import { Command } from "commander";
import { HttpClient } from "./src/http/client.js";
import {
  FileSecretProvider,
  OAuthClient,
  defaultFilePath,
  type SecretProvider,
} from "./src/auth/client.js";
import {
  authExitCodeForError,
  runLogin,
  runLogout,
  runStatus as runAuthStatus,
  runWhoami,
} from "./src/auth/commands.js";
import { exitCodeForError } from "./src/http/client.js";
import { runStatus } from "./src/commands/status.js";
import { runDashboard } from "./src/commands/dashboard.js";
import {
  runBoardsList,
  runBoardsGet,
  InvalidUsageError as BoardsInvalidUsageError,
} from "./src/commands/boards.js";
import {
  runColumnsList,
  runColumnsGet,
} from "./src/commands/columns.js";
import {
  runTasksList,
  runTaskGet,
  runTaskCreate,
  runTaskUpdate,
  runTaskDelete,
  runTaskComplete,
  runTaskMove,
  parseMetaArgs,
  type DateRange,
  type TaskFields,
  type TaskPriority,
  type TaskStatus,
} from "./src/commands/tasks.js";
import { InvalidUsageError as TasksInvalidUsageError } from "./src/commands/boards.js";
import { NotLoggedInError as TasksNotLoggedInError } from "./src/commands/dashboard.js";
import {
  runTasksBatchCreate,
  runTasksBatchUpdate,
  runTasksBatchDelete,
  alignFlagTasks,
  loadTasksFile,
  parseIdsFile,
  splitFlagValues,
  type BatchTaskSpec,
} from "./src/commands/tasks_batch.js";
import {
  runDraftsList,
  runDraftsPublish,
  runDraftsUnpublish,
} from "./src/commands/drafts.js";
import {
  runArchivedList,
  runArchivedArchive,
  runArchivedRestore,
} from "./src/commands/archived.js";
import {
  runCommentsAdd,
  runCommentsList,
  STDIN_BODY_SENTINEL,
} from "./src/commands/comments.js";
import {
  runSubtasksList,
  runSubtasksCreate,
  runSubtasksUpdate,
  runSubtasksDelete,
} from "./src/commands/subtasks.js";

const DEFAULT_API_URL = process.env.KANBAN_API_URL || "http://localhost:8080";
const DEFAULT_PROFILE = process.env.KANBAN_CLI_PROFILE;
const DEFAULT_APP_NAME = "kanban-cli";

function buildOAuthClient(apiUrl: string, profile: string | undefined): OAuthClient {
  const path = defaultFilePath(apiUrl, DEFAULT_APP_NAME);
  const provider: SecretProvider = new FileSecretProvider(path);
  // The OAuthClient reads its metadata (issuer / token_endpoint) from
  // discovery on first use. We pass placeholder values here; authorizeInteractive
  // will trigger discovery via ensureRegistered before they matter.
  const metadata = {
    issuer: apiUrl,
    authorization_endpoint: `${apiUrl}/oauth/authorize`,
    token_endpoint: `${apiUrl}/oauth/token`,
    jwks_uri: `${apiUrl}/.well-known/jwks.json`,
    registration_endpoint: `${apiUrl}/oauth/register`,
    device_authorization_endpoint: `${apiUrl}/oauth/device/code`,
    grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
    response_types_supported: ["code"],
    token_endpoint_auth_methods_supported: ["none"],
  } as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new OAuthClient(apiUrl, metadata as any, provider);
}

const program = new Command();

program
  .name("kanban")
  .description("Open Kanban CLI - command-line client for the Open Kanban board")
  .version("0.1.0")
  .option("--api-url <url>", "Kanban API base URL", DEFAULT_API_URL)
  .option("--profile <name>", "credential profile to use", DEFAULT_PROFILE)
  .option("--output <format>", "output format (table|json)", "table");

const authCmd = program.command("auth").description("manage CLI authentication");

authCmd
  .command("login")
  .description("start OAuth 2.1 device flow and persist credentials")
  .action(async () => {
    const opts = program.opts<{ apiUrl: string; profile?: string }>();
    const oauth = buildOAuthClient(opts.apiUrl, opts.profile);
    try {
      await runLogin(
        { apiUrl: opts.apiUrl, profile: opts.profile },
        { oauth }
      );
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(authExitCodeForError(err));
    }
  });

authCmd
  .command("status")
  .description("show current profile, host, scope, and token lifetime")
  .action(async () => {
    const opts = program.opts<{ apiUrl: string; profile?: string }>();
    const oauth = buildOAuthClient(opts.apiUrl, opts.profile);
    try {
      await runAuthStatus({ apiUrl: opts.apiUrl, profile: opts.profile }, { oauth });
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(authExitCodeForError(err));
    }
  });

authCmd
  .command("logout")
  .description("delete stored credentials")
  .action(async () => {
    const opts = program.opts<{ apiUrl: string; profile?: string }>();
    const oauth = buildOAuthClient(opts.apiUrl, opts.profile);
    try {
      await runLogout({ apiUrl: opts.apiUrl, profile: opts.profile }, { oauth });
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(authExitCodeForError(err));
    }
  });

authCmd
  .command("whoami")
  .description("call GET /api/v1/users/me and show the current user")
  .option("--path <path>", "override the whoami endpoint path", "/api/v1/users/me")
  .action(async (cmdOpts: { path?: string }) => {
    const opts = program.opts<{ apiUrl: string; profile?: string }>();
    const oauth = buildOAuthClient(opts.apiUrl, opts.profile);
    const http = new HttpClient({ apiUrl: opts.apiUrl, profile: opts.profile });
    try {
      await runWhoami(
        { apiUrl: opts.apiUrl, profile: opts.profile },
        { oauth, http, path: cmdOpts.path }
      );
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      // whoami can produce both auth exit codes (2 / 3) and HTTP exit codes
      // (4 not found, 5 server, 6 network). authExitCodeForError handles 2/3/6;
      // fall back to the http-layer mapping for everything else.
      process.exit(authExitCodeForError(err) === 1 ? exitCodeForError(err) : authExitCodeForError(err));
    }
  });

program
  .command("status")
  .description("probe the Kanban API and report latency / boardsCount / apiUrl")
  .action(async () => {
    const opts = program.opts<{ apiUrl: string; output?: string }>();
    const http = new HttpClient({ apiUrl: opts.apiUrl });
    try {
      await runStatus({
        apiUrl: opts.apiUrl,
        format: (opts.output === "json" ? "json" : "table"),
        http,
      });
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(exitCodeForError(err));
    }
  });

program
  .command("dashboard")
  .description("fetch GET /api/v1/dashboard/stats and print a tabular summary")
  .action(async () => {
    const opts = program.opts<{ apiUrl: string; profile?: string; output?: string }>();
    const oauth = buildOAuthClient(opts.apiUrl, opts.profile);
    const http = new HttpClient({ apiUrl: opts.apiUrl, profile: opts.profile });
    http.attachOAuth(oauth);
    try {
      await runDashboard({
        apiUrl: opts.apiUrl,
        format: (opts.output === "json" ? "json" : "table"),
        http,
      });
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(authExitCodeForError(err));
    }
  });

const boardsCmd = program.command("boards").description("manage boards");

boardsCmd
  .command("list")
  .description("list non-deleted boards (GET /api/v1/boards)")
  .option("--fields <fields>", "comma-separated list of fields to show", (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean))
  .action(async (cmdOpts: { fields?: string[] }) => {
    const opts = program.opts<{ apiUrl: string; output?: string }>();
    const http = new HttpClient({ apiUrl: opts.apiUrl });
    try {
      await runBoardsList({
        apiUrl: opts.apiUrl,
        format: opts.output === "json" ? "json" : "table",
        fields: cmdOpts.fields,
        http,
      });
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(exitCodeForError(err));
    }
  });

boardsCmd
  .command("get <id>")
  .description("fetch a single board by id (GET /api/v1/boards/:id)")
  .option("--fields <fields>", "comma-separated list of fields to show", (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean))
  .action(async (id: string, cmdOpts: { fields?: string[] }) => {
    const opts = program.opts<{ apiUrl: string; output?: string }>();
    const http = new HttpClient({ apiUrl: opts.apiUrl });
    try {
      await runBoardsGet(
        {
          apiUrl: opts.apiUrl,
          format: opts.output === "json" ? "json" : "table",
          fields: cmdOpts.fields,
          http,
        },
        id
      );
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      if (err instanceof BoardsInvalidUsageError) {
        process.exit(1);
      }
      process.exit(exitCodeForError(err));
    }
  });

const columnsCmd = program.command("columns").description("manage columns");

columnsCmd
  .command("list")
  .description("list columns (GET /api/v1/columns)")
  .option("--board <id>", "filter by board id")
  .option(
    "--positions <list>",
    "comma-separated list of positions to include (e.g. 1,3,5)",
    (v: string) =>
      v
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n))
  )
  .option(
    "--fields <fields>",
    "comma-separated list of fields to show",
    (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean)
  )
  .action(
    async (cmdOpts: {
      board?: string;
      positions?: number[];
      fields?: string[];
    }) => {
      const opts = program.opts<{ apiUrl: string; output?: string }>();
      const http = new HttpClient({ apiUrl: opts.apiUrl });
      try {
        await runColumnsList({
          apiUrl: opts.apiUrl,
          boardId: cmdOpts.board,
          positions: cmdOpts.positions,
          format: opts.output === "json" ? "json" : "table",
          fields: cmdOpts.fields,
          http,
        });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        if (err instanceof BoardsInvalidUsageError) {
          process.exit(1);
        }
        process.exit(exitCodeForError(err));
      }
    }
  );

columnsCmd
  .command("get <id>")
  .description("fetch a single column by id (GET /api/v1/columns/:id)")
  .option(
    "--fields <fields>",
    "comma-separated list of fields to show",
    (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean)
  )
  .action(async (id: string, cmdOpts: { fields?: string[] }) => {
    const opts = program.opts<{ apiUrl: string; output?: string }>();
    const http = new HttpClient({ apiUrl: opts.apiUrl });
    try {
      await runColumnsGet(
        {
          apiUrl: opts.apiUrl,
          format: opts.output === "json" ? "json" : "table",
          fields: cmdOpts.fields,
          http,
        },
        id
      );
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      if (err instanceof BoardsInvalidUsageError) {
        process.exit(1);
      }
      process.exit(exitCodeForError(err));
    }
  });

const tasksCmd = program.command("tasks").description("manage tasks");

function tasksExitCode(err: unknown): number {
  if (err instanceof TasksInvalidUsageError) return 1;
  if (err instanceof TasksNotLoggedInError) return authExitCodeForError(err);
  return authExitCodeForError(err);
}

tasksCmd
  .command("list")
  .description("list tasks (filters client-side over GET /api/v1/columns)")
  .option("--board <id>", "filter by board id")
  .option("--column <id>", "filter by column id (mutually exclusive with --status)")
  .option(
    "--status <status>",
    "filter by status (todo|in_progress|review|done); mutually exclusive with --column"
  )
  .option("--agent-type <type>", "filter by column agentConfig.agentTypes")
  .option(
    "--priority <priority>",
    "filter by priority (low|medium|high)"
  )
  .option("--assignee <username>", "filter by assignee username")
  .option("--search <query>", "free-text search across title and description")
  .option(
    "--since <range>",
    "filter by creation date (today|thisWeek|thisMonth)"
  )
  .option("--tag <tag>", "filter by a meta value (substring match)")
  .option(
    "--lightweight",
    "return only id/title/priority/assignee/createdAt (default behaviour)",
    false
  )
  .option(
    "--fields <set>",
    "field set for change-detection (id|id+updated)",
    (v: string): TaskFields => {
      const t = v.trim();
      if (t !== "id" && t !== "id+updated") {
        throw new TasksInvalidUsageError(
          `invalid --fields value: ${v} (allowed: id, id+updated)`
        );
      }
      return t as TaskFields;
    }
  )
  .action(
    async (cmdOpts: {
      board?: string;
      column?: string;
      status?: string;
      agentType?: string;
      priority?: string;
      assignee?: string;
      search?: string;
      since?: string;
      tag?: string;
      lightweight?: boolean;
      fields?: TaskFields;
    }) => {
      const opts = program.opts<{ apiUrl: string; output?: string }>();
      const http = new HttpClient({ apiUrl: opts.apiUrl });
      try {
        await runTasksList({
          apiUrl: opts.apiUrl,
          boardId: cmdOpts.board,
          columnId: cmdOpts.column,
          status: cmdOpts.status as TaskStatus | undefined,
          agentType: cmdOpts.agentType,
          priority: cmdOpts.priority as TaskPriority | undefined,
          assignee: cmdOpts.assignee,
          search: cmdOpts.search,
          since: cmdOpts.since as DateRange | undefined,
          tag: cmdOpts.tag,
          lightweight: cmdOpts.lightweight,
          fields: cmdOpts.fields,
          format: opts.output === "json" ? "json" : "table",
          http,
        });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(tasksExitCode(err));
      }
    }
  );

tasksCmd
  .command("get <id>")
  .description("fetch a single task by id (GET /api/v1/tasks/:id)")
  .action(async (id: string) => {
    const opts = program.opts<{ apiUrl: string; output?: string }>();
    const http = new HttpClient({ apiUrl: opts.apiUrl });
    try {
      await runTaskGet(
        {
          apiUrl: opts.apiUrl,
          format: opts.output === "json" ? "json" : "table",
          http,
        },
        id
      );
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(tasksExitCode(err));
    }
  });

tasksCmd
  .command("create")
  .description("create a task (POST /api/v1/tasks)")
  .requiredOption("--title <title>", "task title (required)")
  .option("--description <description>", "task description")
  .option("--column <id>", "target column id (mutually exclusive with --status)")
  .option(
    "--status <status>",
    "target status (todo|in_progress|review|done); mutually exclusive with --column"
  )
  .option("--board <id>", "default board for status→column resolution")
  .option(
    "--priority <priority>",
    "task priority (low|medium|high); defaults to medium"
  )
  .option("--assignee <username>", "task assignee username")
  .option(
    "--meta <kv...>",
    "metadata key=value pairs (repeatable or comma-separated)"
  )
  .option("--no-publish", "create as a draft instead of a published task")
  .action(
    async (cmdOpts: {
      title: string;
      description?: string;
      column?: string;
      status?: string;
      board?: string;
      priority?: string;
      assignee?: string;
      meta?: string[];
      publish?: boolean;
    }) => {
      const opts = program.opts<{ apiUrl: string; output?: string }>();
      const oauth = buildOAuthClient(opts.apiUrl, undefined);
      const http = new HttpClient({ apiUrl: opts.apiUrl });
      http.attachOAuth(oauth);
      try {
        await runTaskCreate({
          apiUrl: opts.apiUrl,
          title: cmdOpts.title,
          description: cmdOpts.description,
          columnId: cmdOpts.column,
          status: cmdOpts.status as TaskStatus | undefined,
          boardId: cmdOpts.board,
          priority: cmdOpts.priority as TaskPriority | undefined,
          assignee: cmdOpts.assignee,
          meta: parseMetaArgs(cmdOpts.meta),
          published: cmdOpts.publish,
          format: opts.output === "json" ? "json" : "table",
          http,
        });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(tasksExitCode(err));
      }
    }
  );

tasksCmd
  .command("update <id>")
  .description("update a task (PUT /api/v1/tasks/:id)")
  .option("--title <title>", "new title")
  .option("--description <description>", "new description")
  .option(
    "--priority <priority>",
    "new priority (low|medium|high)"
  )
  .option("--assignee <username>", "new assignee username")
  .option(
    "--meta <kv...>",
    "new metadata key=value pairs (repeatable or comma-separated)"
  )
  .option("--column <id>", "move task to this column (mutually exclusive with --status)")
  .option(
    "--status <status>",
    "move task to the column with this status (todo|in_progress|review|done); mutually exclusive with --column"
  )
  .action(
    async (
      id: string,
      cmdOpts: {
        title?: string;
        description?: string;
        priority?: string;
        assignee?: string;
        meta?: string[];
        column?: string;
        status?: string;
      }
    ) => {
      const opts = program.opts<{ apiUrl: string; output?: string }>();
      const oauth = buildOAuthClient(opts.apiUrl, undefined);
      const http = new HttpClient({ apiUrl: opts.apiUrl });
      http.attachOAuth(oauth);
      try {
        await runTaskUpdate(
          {
            apiUrl: opts.apiUrl,
            title: cmdOpts.title,
            description: cmdOpts.description,
            priority: cmdOpts.priority as TaskPriority | undefined,
            assignee: cmdOpts.assignee,
            meta: parseMetaArgs(cmdOpts.meta),
            columnId: cmdOpts.column,
            status: cmdOpts.status as TaskStatus | undefined,
            format: opts.output === "json" ? "json" : "table",
            http,
          },
          id
        );
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(tasksExitCode(err));
      }
    }
  );

tasksCmd
  .command("delete <id>")
  .description("delete a task (DELETE /api/v1/tasks/:id); --yes skips confirmation")
  .option("--yes", "skip confirmation prompt (default behaviour)", false)
  .action(async (id: string, _cmdOpts: { yes?: boolean }) => {
    const opts = program.opts<{ apiUrl: string; output?: string }>();
    const oauth = buildOAuthClient(opts.apiUrl, undefined);
    const http = new HttpClient({ apiUrl: opts.apiUrl });
    http.attachOAuth(oauth);
    try {
      await runTaskDelete(
        {
          apiUrl: opts.apiUrl,
          yes: true,
          format: opts.output === "json" ? "json" : "table",
          http,
        },
        id
      );
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(tasksExitCode(err));
    }
  });

tasksCmd
  .command("complete <id>")
  .description(
    "advance a task to the next column (POST /api/v1/tasks/:id/complete)"
  )
  .action(async (id: string) => {
    const opts = program.opts<{ apiUrl: string; output?: string }>();
    const oauth = buildOAuthClient(opts.apiUrl, undefined);
    const http = new HttpClient({ apiUrl: opts.apiUrl });
    http.attachOAuth(oauth);
    try {
      await runTaskComplete(
        {
          apiUrl: opts.apiUrl,
          format: opts.output === "json" ? "json" : "table",
          http,
        },
        id
      );
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(tasksExitCode(err));
    }
  });

tasksCmd
  .command("move <id>")
  .description(
    "move a task to a target column or status (PUT /api/v1/tasks/:id with columnId)"
  )
  .option("--column <id>", "target column id (mutually exclusive with --status)")
  .option(
    "--status <status>",
    "target status (todo|in_progress|review|done); mutually exclusive with --column"
  )
  .action(
    async (
      id: string,
      cmdOpts: { column?: string; status?: string }
    ) => {
      const opts = program.opts<{ apiUrl: string; output?: string }>();
      const oauth = buildOAuthClient(opts.apiUrl, undefined);
      const http = new HttpClient({ apiUrl: opts.apiUrl });
      http.attachOAuth(oauth);
      try {
        await runTaskMove(
          {
            apiUrl: opts.apiUrl,
            columnId: cmdOpts.column,
            status: cmdOpts.status as TaskStatus | undefined,
            format: opts.output === "json" ? "json" : "table",
            http,
          },
          id
        );
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(tasksExitCode(err));
      }
    }
  );

const tasksBatchCmd = tasksCmd
  .command("batch")
  .description("batch task operations (create / update / delete)");

function tasksBatchExitCode(err: unknown): number {
  if (err instanceof TasksInvalidUsageError) return 1;
  if (err instanceof TasksNotLoggedInError) return authExitCodeForError(err);
  return authExitCodeForError(err);
}

tasksBatchCmd
  .command("create")
  .description(
    "create multiple tasks (POST /api/v1/tasks/batch); input from --file or repeated --title/--column flags"
  )
  .option(
    "--file <path>",
    "read tasks from a JSON or YAML file (single object or array of objects)"
  )
  .option(
    "--title <title>",
    "task title; repeat for multiple tasks",
    splitFlagValues
  )
  .option("--description <description>", "task description", splitFlagValues)
  .option("--column <id>", "target column id", splitFlagValues)
  .option(
    "--status <status>",
    "target status (todo|in_progress|review|done)",
    splitFlagValues
  )
  .option(
    "--priority <priority>",
    "task priority (low|medium|high)",
    splitFlagValues
  )
  .option("--assignee <username>", "task assignee username", splitFlagValues)
  .option("--published", "publish each task (default behaviour)", splitFlagValues)
  .action(
    async (cmdOpts: {
      file?: string;
      title?: string[];
      description?: string[];
      column?: string[];
      status?: string[];
      priority?: string[];
      assignee?: string[];
      published?: boolean[] | string[];
    }) => {
      const opts = program.opts<{ apiUrl: string; output?: string }>();
      const oauth = buildOAuthClient(opts.apiUrl, undefined);
      const http = new HttpClient({ apiUrl: opts.apiUrl });
      http.attachOAuth(oauth);
      try {
        let tasks: BatchTaskSpec[];
        if (cmdOpts.file) {
          tasks = await loadTasksFile(cmdOpts.file);
        } else {
          tasks = alignFlagTasks({
            titles: splitFlagValues(cmdOpts.title),
            columns: splitFlagValues(cmdOpts.column),
            descriptions: splitFlagValues(cmdOpts.description),
            priorities: splitFlagValues(cmdOpts.priority),
            assignees: splitFlagValues(cmdOpts.assignee),
            statuses: splitFlagValues(cmdOpts.status),
            publisheds: coerceBooleans(splitFlagValues(cmdOpts.published as string[] | string | undefined)),
          });
        }
        await runTasksBatchCreate({
          apiUrl: opts.apiUrl,
          tasks,
          format: opts.output === "json" ? "json" : "table",
          http,
        });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(tasksBatchExitCode(err));
      }
    }
  );

tasksBatchCmd
  .command("update <ids...>")
  .description(
    "update multiple tasks (PUT /api/v1/tasks/batch) with the same column/status/priority/assignee"
  )
  .option(
    "--file <path>",
    "read ids from a UTF-8 text file (one id per line, # comments allowed)"
  )
  .option("--column <id>", "move tasks to this column (mutually exclusive with --status)")
  .option(
    "--status <status>",
    "move tasks to the column with this status (todo|in_progress|review|done); mutually exclusive with --column"
  )
  .option("--priority <priority>", "new priority (low|medium|high)")
  .option("--assignee <username>", "new assignee username")
  .action(
    async (
      ids: string[],
      cmdOpts: {
        file?: string;
        column?: string;
        status?: string;
        priority?: string;
        assignee?: string;
      }
    ) => {
      const opts = program.opts<{ apiUrl: string; output?: string }>();
      const oauth = buildOAuthClient(opts.apiUrl, undefined);
      const http = new HttpClient({ apiUrl: opts.apiUrl });
      http.attachOAuth(oauth);
      try {
        const fromFile = cmdOpts.file ? await parseIdsFile(cmdOpts.file) : [];
        const allIds = [...ids, ...fromFile];
        await runTasksBatchUpdate({
          apiUrl: opts.apiUrl,
          ids: allIds,
          columnId: cmdOpts.column,
          status: cmdOpts.status as TaskStatus | undefined,
          priority: cmdOpts.priority as TaskPriority | undefined,
          assignee: cmdOpts.assignee,
          format: opts.output === "json" ? "json" : "table",
          http,
        });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(tasksBatchExitCode(err));
      }
    }
  );

tasksBatchCmd
  .command("delete <ids...>")
  .description(
    "delete multiple tasks (DELETE /api/v1/tasks/batch); --yes is the default and can be omitted"
  )
  .option(
    "--file <path>",
    "read ids from a UTF-8 text file (one id per line, # comments allowed)"
  )
  .option("--yes", "skip confirmation prompt (default behaviour)", false)
  .action(
    async (
      ids: string[],
      cmdOpts: { file?: string; yes?: boolean }
    ) => {
      const opts = program.opts<{ apiUrl: string; output?: string }>();
      const oauth = buildOAuthClient(opts.apiUrl, undefined);
      const http = new HttpClient({ apiUrl: opts.apiUrl });
      http.attachOAuth(oauth);
      try {
        const fromFile = cmdOpts.file ? await parseIdsFile(cmdOpts.file) : [];
        const allIds = [...ids, ...fromFile];
        await runTasksBatchDelete({
          apiUrl: opts.apiUrl,
          ids: allIds,
          yes: true,
          format: opts.output === "json" ? "json" : "table",
          http,
        });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(tasksBatchExitCode(err));
      }
    }
  );

function coerceBooleans(values: string[]): boolean[] {
  return values.map((v) => {
    const t = String(v).trim().toLowerCase();
    if (t === "true" || t === "1" || t === "yes") return true;
    if (t === "false" || t === "0" || t === "no") return false;
    throw new TasksInvalidUsageError(
      `invalid boolean value: ${v} (allowed: true|false)`
    );
  });
}

const draftsCmd = program.command("drafts").description("manage draft tasks");

function draftsExitCode(err: unknown): number {
  if (err instanceof TasksInvalidUsageError) return 1;
  if (err instanceof TasksNotLoggedInError) return authExitCodeForError(err);
  return authExitCodeForError(err);
}

draftsCmd
  .command("list")
  .description("list draft tasks (GET /api/v1/drafts)")
  .option("--board <id>", "filter by board id")
  .action(async (cmdOpts: { board?: string }) => {
    const opts = program.opts<{ apiUrl: string; profile?: string; output?: string }>();
    const oauth = buildOAuthClient(opts.apiUrl, opts.profile);
    const http = new HttpClient({ apiUrl: opts.apiUrl, profile: opts.profile });
    http.attachOAuth(oauth);
    try {
      await runDraftsList({
        apiUrl: opts.apiUrl,
        boardId: cmdOpts.board,
        format: opts.output === "json" ? "json" : "table",
        http,
      });
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(draftsExitCode(err));
    }
  });

draftsCmd
  .command("publish <id>")
  .description("publish a draft task (PUT /api/v1/tasks/:id with { published: true })")
  .action(async (id: string) => {
    const opts = program.opts<{ apiUrl: string; profile?: string; output?: string }>();
    const oauth = buildOAuthClient(opts.apiUrl, opts.profile);
    const http = new HttpClient({ apiUrl: opts.apiUrl, profile: opts.profile });
    http.attachOAuth(oauth);
    try {
      await runDraftsPublish(
        {
          apiUrl: opts.apiUrl,
          format: opts.output === "json" ? "json" : "table",
          http,
        },
        id
      );
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(draftsExitCode(err));
    }
  });

draftsCmd
  .command("unpublish <id>")
  .description(
    "unpublish a task back into drafts (PUT /api/v1/tasks/:id with { published: false })"
  )
  .action(async (id: string) => {
    const opts = program.opts<{ apiUrl: string; profile?: string; output?: string }>();
    const oauth = buildOAuthClient(opts.apiUrl, opts.profile);
    const http = new HttpClient({ apiUrl: opts.apiUrl, profile: opts.profile });
    http.attachOAuth(oauth);
    try {
      await runDraftsUnpublish(
        {
          apiUrl: opts.apiUrl,
          format: opts.output === "json" ? "json" : "table",
          http,
        },
        id
      );
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(draftsExitCode(err));
    }
  });

const archivedCmd = program.command("archived").description("manage archived tasks");

function archivedExitCode(err: unknown): number {
  if (err instanceof TasksInvalidUsageError) return 1;
  if (err instanceof TasksNotLoggedInError) return authExitCodeForError(err);
  return authExitCodeForError(err);
}

archivedCmd
  .command("list")
  .description("list archived tasks (GET /api/v1/archived)")
  .option("--board <id>", "filter by board id")
  .action(async (cmdOpts: { board?: string }) => {
    const opts = program.opts<{ apiUrl: string; profile?: string; output?: string }>();
    const oauth = buildOAuthClient(opts.apiUrl, opts.profile);
    const http = new HttpClient({ apiUrl: opts.apiUrl, profile: opts.profile });
    http.attachOAuth(oauth);
    try {
      await runArchivedList({
        apiUrl: opts.apiUrl,
        boardId: cmdOpts.board,
        format: opts.output === "json" ? "json" : "table",
        http,
      });
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(archivedExitCode(err));
    }
  });

archivedCmd
  .command("archive <id>")
  .description(
    "archive a task (POST /api/v1/tasks/:id/archive with { archived: true }); --yes is the default"
  )
  .option("--yes", "skip confirmation prompt (default behaviour)", false)
  .action(async (id: string, _cmdOpts: { yes?: boolean }) => {
    const opts = program.opts<{ apiUrl: string; profile?: string; output?: string }>();
    const oauth = buildOAuthClient(opts.apiUrl, opts.profile);
    const http = new HttpClient({ apiUrl: opts.apiUrl, profile: opts.profile });
    http.attachOAuth(oauth);
    try {
      await runArchivedArchive(
        {
          apiUrl: opts.apiUrl,
          yes: true,
          format: opts.output === "json" ? "json" : "table",
          http,
        },
        id
      );
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(archivedExitCode(err));
    }
  });

archivedCmd
  .command("restore <id>")
  .description(
    "restore an archived task (POST /api/v1/tasks/:id/archive with { archived: false })"
  )
  .action(async (id: string) => {
    const opts = program.opts<{ apiUrl: string; profile?: string; output?: string }>();
    const oauth = buildOAuthClient(opts.apiUrl, opts.profile);
    const http = new HttpClient({ apiUrl: opts.apiUrl, profile: opts.profile });
    http.attachOAuth(oauth);
    try {
      await runArchivedRestore(
        {
          apiUrl: opts.apiUrl,
          format: opts.output === "json" ? "json" : "table",
          http,
        },
        id
      );
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(archivedExitCode(err));
    }
  });

const commentsCmd = program.command("comments").description("manage task comments");

function commentsExitCode(err: unknown): number {
  if (err instanceof TasksInvalidUsageError) return 1;
  if (err instanceof TasksNotLoggedInError) return authExitCodeForError(err);
  return authExitCodeForError(err);
}

commentsCmd
  .command("add <taskId>")
  .description(
    "add a comment to a task (POST /api/v1/comments); pass --body - to read the body from stdin"
  )
  .requiredOption(
    "--body <text>",
    `comment body, or "${STDIN_BODY_SENTINEL}" to read from stdin`
  )
  .option("--author <name>", "optional author override (server uses authenticated user by default)")
  .action(async (taskId: string, cmdOpts: { body: string; author?: string }) => {
    const opts = program.opts<{ apiUrl: string; profile?: string; output?: string }>();
    const oauth = buildOAuthClient(opts.apiUrl, opts.profile);
    const http = new HttpClient({ apiUrl: opts.apiUrl, profile: opts.profile });
    http.attachOAuth(oauth);
    try {
      await runCommentsAdd(
        {
          apiUrl: opts.apiUrl,
          body: cmdOpts.body,
          author: cmdOpts.author,
          format: opts.output === "json" ? "json" : "table",
          http,
        },
        taskId
      );
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(commentsExitCode(err));
    }
  });

commentsCmd
  .command("list <taskId>")
  .description("list comments for a task (GET /api/v1/comments?taskId=...)")
  .action(async (taskId: string) => {
    const opts = program.opts<{ apiUrl: string; profile?: string; output?: string }>();
    const oauth = buildOAuthClient(opts.apiUrl, opts.profile);
    const http = new HttpClient({ apiUrl: opts.apiUrl, profile: opts.profile });
    http.attachOAuth(oauth);
    try {
      await runCommentsList(
        {
          apiUrl: opts.apiUrl,
          format: opts.output === "json" ? "json" : "table",
          http,
        },
        taskId
      );
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(commentsExitCode(err));
    }
  });

const subtasksCmd = program.command("subtasks").description("manage task subtasks");

function subtasksExitCode(err: unknown): number {
  if (err instanceof TasksInvalidUsageError) return 1;
  if (err instanceof TasksNotLoggedInError) return authExitCodeForError(err);
  return authExitCodeForError(err);
}

subtasksCmd
  .command("list <taskId>")
  .description("list subtasks for a task (GET /api/v1/subtasks?taskId=...)")
  .action(async (taskId: string) => {
    const opts = program.opts<{ apiUrl: string; profile?: string; output?: string }>();
    const oauth = buildOAuthClient(opts.apiUrl, opts.profile);
    const http = new HttpClient({ apiUrl: opts.apiUrl, profile: opts.profile });
    http.attachOAuth(oauth);
    try {
      await runSubtasksList(
        {
          apiUrl: opts.apiUrl,
          format: opts.output === "json" ? "json" : "table",
          http,
        },
        taskId
      );
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(subtasksExitCode(err));
    }
  });

subtasksCmd
  .command("create <taskId>")
  .description("create a subtask on a task (POST /api/v1/subtasks)")
  .requiredOption("--title <title>", "subtask title (required)")
  .action(async (taskId: string, cmdOpts: { title: string }) => {
    const opts = program.opts<{ apiUrl: string; profile?: string; output?: string }>();
    const oauth = buildOAuthClient(opts.apiUrl, opts.profile);
    const http = new HttpClient({ apiUrl: opts.apiUrl, profile: opts.profile });
    http.attachOAuth(oauth);
    try {
      await runSubtasksCreate(
        {
          apiUrl: opts.apiUrl,
          title: cmdOpts.title,
          format: opts.output === "json" ? "json" : "table",
          http,
        },
        taskId
      );
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(subtasksExitCode(err));
    }
  });

subtasksCmd
  .command("update <id>")
  .description(
    "update a subtask (PUT /api/v1/subtasks/:id); pass --title and/or --completed/--no-completed"
  )
  .option("--title <title>", "new subtask title")
  .option(
    "--completed",
    "mark the subtask as completed (use --no-completed to mark as incomplete)"
  )
  .action(
    async (
      id: string,
      cmdOpts: { title?: string; completed?: boolean }
    ) => {
      const opts = program.opts<{ apiUrl: string; profile?: string; output?: string }>();
      const oauth = buildOAuthClient(opts.apiUrl, opts.profile);
      const http = new HttpClient({ apiUrl: opts.apiUrl, profile: opts.profile });
      http.attachOAuth(oauth);
      try {
        await runSubtasksUpdate(
          {
            apiUrl: opts.apiUrl,
            title: cmdOpts.title,
            completed: cmdOpts.completed,
            format: opts.output === "json" ? "json" : "table",
            http,
          },
          id
        );
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(subtasksExitCode(err));
      }
    }
  );

subtasksCmd
  .command("delete <id>")
  .description("delete a subtask (DELETE /api/v1/subtasks/:id); --yes is the default")
  .option("--yes", "skip confirmation prompt (default behaviour)", false)
  .action(async (id: string, _cmdOpts: { yes?: boolean }) => {
    const opts = program.opts<{ apiUrl: string; profile?: string; output?: string }>();
    const oauth = buildOAuthClient(opts.apiUrl, opts.profile);
    const http = new HttpClient({ apiUrl: opts.apiUrl, profile: opts.profile });
    http.attachOAuth(oauth);
    try {
      await runSubtasksDelete(
        {
          apiUrl: opts.apiUrl,
          yes: true,
          format: opts.output === "json" ? "json" : "table",
          http,
        },
        id
      );
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(subtasksExitCode(err));
    }
  });

program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
