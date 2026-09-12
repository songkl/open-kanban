// Commander program builder for the Open Kanban CLI.
//
// This file owns the entire command tree (`auth`, `status`, `dashboard`,
// `boards`, `columns`, `tasks`, ...). Both the top-level CLI entry
// (`cli/index.ts`) and the interactive shell (`cli/src/commands/shell.ts`)
// call `createProgram` to obtain a configured `Command` instance. Keeping
// the tree here means new commands only need to be registered once and
// both call-sites pick them up automatically.
//
// The action handlers preserve the same error/exit-code mapping the legacy
// `index.ts` had: any thrown error is mapped through `exitCodeForError` /
// `authExitCodeForError` and `process.exit(code)` is called. The shell
// subprocess monkey-patches `process.exit` so those `exit()` calls do not
// terminate the REPL.

import { Command } from "commander";
import { HttpClient } from "./http/client.js";
import { parseColorFlag } from "./output/color.js";
import { setColorOverride } from "./config.js";
import { resolveOutputFormat } from "./output/format.js";
import {
  FileSecretProvider,
  OAuthClient,
  defaultFilePath,
  type SecretProvider,
} from "./auth/client.js";
import {
  authExitCodeForError,
  runLogin,
  runLogout,
  runStatus as runAuthStatus,
  runWhoami,
} from "./auth/commands.js";
import { exitCodeForError } from "./http/client.js";
import { runStatus } from "./commands/status.js";
import { runDashboard } from "./commands/dashboard.js";
import {
  runBoardsList,
  runBoardsGet,
  InvalidUsageError as BoardsInvalidUsageError,
} from "./commands/boards.js";
import {
  runColumnsList,
  runColumnsGet,
} from "./commands/columns.js";
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
} from "./commands/tasks.js";
import { InvalidUsageError as TasksInvalidUsageError } from "./commands/boards.js";
import { NotLoggedInError as TasksNotLoggedInError } from "./commands/dashboard.js";
import {
  runTasksBatchCreate,
  runTasksBatchUpdate,
  runTasksBatchDelete,
  alignFlagTasks,
  loadTasksFile,
  parseIdsFile,
  splitFlagValues,
  type BatchTaskSpec,
} from "./commands/tasks_batch.js";
import {
  runDraftsList,
  runDraftsPublish,
  runDraftsUnpublish,
} from "./commands/drafts.js";
import {
  runArchivedList,
  runArchivedArchive,
  runArchivedRestore,
} from "./commands/archived.js";
import {
  runCommentsAdd,
  runCommentsList,
  STDIN_BODY_SENTINEL,
} from "./commands/comments.js";
import {
  runSubtasksList,
  runSubtasksCreate,
  runSubtasksUpdate,
  runSubtasksDelete,
} from "./commands/subtasks.js";
import { runMine } from "./commands/mine.js";
import { runRunCommand, InvalidUsageError as RunInvalidUsageError } from "./commands/run.js";
import {
  runRunnerInitCommand,
  RunnerInitError as RunInitError,
} from "./commands/run_init.js";
import {
  input as inquirerInput,
  select as inquirerSelect,
  number as inquirerNumber,
  confirm as inquirerConfirm,
  password as inquirerPassword,
} from "@inquirer/prompts";
import {
  runWorkspaceUpload,
  runWorkspaceBatchUpload,
  runWorkspaceList,
  runWorkspaceRead,
  runWorkspaceDelete,
  runWorkspaceStats,
} from "./commands/workspace.js";
import { runShell } from "./commands/shell.js";
import {
  runCompletion,
  runComplete,
  UnsupportedShellError,
} from "./commands/completion.js";
import {
  runConfigGet,
  runConfigSet,
  InvalidConfigKeyError,
  InvalidConfigValueError,
  extractCliFlags,
} from "./commands/config.js";
import {
  runAgentsList,
  runAgentCreate,
  runAgentBind,
  runAgentDelete,
} from "./commands/agents.js";

const DEFAULT_APP_NAME = "kanban-cli";
const PROGRAM_VERSION = "0.1.0";

export function buildOAuthClient(apiUrl: string, profile: string | undefined): OAuthClient {
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

// ProgramDeps captures the runtime collaborators every command needs.
// Both `cli/index.ts` (top-level) and `cli/src/commands/shell.ts` (REPL)
// construct these once and pass them to `createProgram`.
export interface ProgramDeps {
  // oauth is the OAuth client wired to a file-backed token store.
  // Commands that need authentication attach it to their HttpClient.
  oauth: OAuthClient;
  // http is the API client. Pre-attached with `oauth` so commands can
  // `apiGet` / `apiPost` etc. and have bearer tokens added automatically.
  http: HttpClient;
  // version is the value reported by `--version`. Tests inject a fixed
  // string so they don't depend on the version in `package.json`.
  version?: string;
}

export interface CreateProgramOptions {
  apiUrl: string;
  profile?: string;
}

// createProgram wires the entire command tree against the supplied
// dependencies. The returned `Command` instance is configured but not
// yet parsing — callers invoke `program.parseAsync(argv)` themselves.
export function createProgram(
  opts: CreateProgramOptions,
  deps: ProgramDeps
): Command {
  const { oauth, http } = deps;
  const version = deps.version ?? PROGRAM_VERSION;

  const program = new Command();

  program
    .name("kanban")
    .description("Open Kanban CLI - command-line client for the Open Kanban board")
    .version(version)
    .option("--api-url <url>", "Kanban API base URL", opts.apiUrl)
    .option("--profile <name>", "credential profile to use", opts.profile)
    .option("--output <format>", "output format (table|json|yaml)", "table")
    .option("--no-color", "disable ANSI color in table output")
    .option("--color <mode>", "force color on/off (on|off|auto)", "auto");

  // Apply the resolved colour override once, after Commander has parsed
  // argv. Doing it here keeps every command file agnostic of Commander.
  program.hook("preAction", () => {
    const o = program.opts<{ color?: unknown }>();
    setColorOverride(parseColorFlag(o.color));
  });

  // ---- auth ----
  const authCmd = program.command("auth").description("manage CLI authentication");

  authCmd
    .command("login")
    .description("start OAuth 2.1 device flow and persist credentials")
    .action(async () => {
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
      try {
        await runWhoami(
          { apiUrl: opts.apiUrl, profile: opts.profile },
          { oauth, http, path: cmdOpts.path }
        );
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(
          authExitCodeForError(err) === 1 ? exitCodeForError(err) : authExitCodeForError(err)
        );
      }
    });

  // ---- auth agent ----
  // Binds the CLI to an Agent identity instead of the human approver's
  // session, so `kanban auth login` no longer leaks the admin identity
  // into unattended automation. See `auth agent create / bind` below.

  const agentCmd = authCmd.command("agent").description(
    "manage the Agent identity bound to the CLI (unattended / automation use)"
  );

  agentCmd
    .command("list")
    .description("list configured Agents on the server (admin OAuth session required)")
    .action(async () => {
      const o = program.opts<{ output?: string }>();
      try {
        await runAgentsList({
          apiUrl: opts.apiUrl,
          format: resolveOutputFormat(o.output),
          http,
        });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(exitCodeForError(err));
      }
    });

  agentCmd
    .command("create <nickname>")
    .description(
      "create a new Agent on the server and bind its API token to the CLI profile (admin OAuth session required)"
    )
    .option("--avatar <url>", "avatar URL for the new Agent")
    .option("--role <role>", "role for the new Agent (ADMIN|MEMBER|VIEWER)", "ADMIN")
    .option(
      "--no-bind",
      "do not persist the new token to the credential store (dry run)"
    )
    .action(
      async (
        nickname: string,
        cmdOpts: { avatar?: string; role?: string; bind?: boolean }
      ) => {
        const o = program.opts<{ output?: string }>();
        try {
          const role = (cmdOpts.role ?? "ADMIN").toUpperCase();
          if (role !== "ADMIN" && role !== "MEMBER" && role !== "VIEWER") {
            process.stderr.write(
              `Invalid --role: ${cmdOpts.role}. Use one of ADMIN, MEMBER, VIEWER.\n`
            );
            process.exit(1);
          }
          await runAgentCreate(
            {
              apiUrl: opts.apiUrl,
              nickname,
              avatar: cmdOpts.avatar,
              role: role as "ADMIN" | "MEMBER" | "VIEWER",
              bindWhenFinished: cmdOpts.bind !== false,
              format: resolveOutputFormat(o.output),
              http,
              oauth,
            },
            nickname
          );
        } catch (err) {
          process.stderr.write(`${(err as Error).message}\n`);
          process.exit(exitCodeForError(err));
        }
      }
    );

  agentCmd
    .command("bind")
    .description(
      "bind the CLI to an existing Agent API token (issued via the web UI or `kanban auth agent create`)"
    )
    .option("--token <token>", "Agent API token to persist (else KANBAN_AGENT_TOKEN, else prompt)")
    .action(async (cmdOpts: { token?: string }) => {
      const o = program.opts<{ output?: string }>();
      try {
        await runAgentBind({
          apiUrl: opts.apiUrl,
          token: cmdOpts.token,
          format: resolveOutputFormat(o.output),
          http,
          oauth,
          prompt: async () =>
            inquirerPassword({
              message: "Agent API token:",
              validate: (v: string) =>
                v && v.trim().length > 0 ? true : "Token is required",
            }),
        });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(exitCodeForError(err));
      }
    });

  agentCmd
    .command("delete <agentId>")
    .description("delete an Agent (admin OAuth session required)")
    .action(async (agentId: string) => {
      const o = program.opts<{ output?: string }>();
      try {
        await runAgentDelete(
          {
            apiUrl: opts.apiUrl,
            format: resolveOutputFormat(o.output),
            http,
          },
          agentId
        );
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(exitCodeForError(err));
      }
    });

  // ---- status / dashboard ----
  program
    .command("status")
    .description("probe the Kanban API and report latency / boardsCount / apiUrl")
    .action(async () => {
      const o = program.opts<{ output?: string }>();
      try {
        await runStatus({
          apiUrl: opts.apiUrl,
          format: resolveOutputFormat(o.output),
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
      const o = program.opts<{ output?: string }>();
      try {
        await runDashboard({
          apiUrl: opts.apiUrl,
          format: resolveOutputFormat(o.output),
          http,
        });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(authExitCodeForError(err));
      }
    });

  // ---- boards ----
  const boardsCmd = program.command("boards").description("manage boards");

  boardsCmd
    .command("list")
    .description("list non-deleted boards (GET /api/v1/boards)")
    .option("--fields <fields>", "comma-separated list of fields to show", (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean))
    .action(async (cmdOpts: { fields?: string[] }) => {
      const o = program.opts<{ output?: string }>();
      try {
        await runBoardsList({
          apiUrl: opts.apiUrl,
          format: resolveOutputFormat(o.output),
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
      const o = program.opts<{ output?: string }>();
      try {
        await runBoardsGet(
          {
            apiUrl: opts.apiUrl,
            format: resolveOutputFormat(o.output),
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

  // ---- columns ----
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
        const o = program.opts<{ output?: string }>();
        try {
          await runColumnsList({
            apiUrl: opts.apiUrl,
            boardId: cmdOpts.board,
            positions: cmdOpts.positions,
            format: resolveOutputFormat(o.output),
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
      const o = program.opts<{ output?: string }>();
      try {
        await runColumnsGet(
          {
            apiUrl: opts.apiUrl,
            format: resolveOutputFormat(o.output),
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

  // ---- tasks ----
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
        const o = program.opts<{ output?: string }>();
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
            format: resolveOutputFormat(o.output),
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
      const o = program.opts<{ output?: string }>();
      try {
        await runTaskGet(
          {
            apiUrl: opts.apiUrl,
            format: resolveOutputFormat(o.output),
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
        const o = program.opts<{ output?: string }>();
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
            format: resolveOutputFormat(o.output),
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
        const o = program.opts<{ output?: string }>();
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
              format: resolveOutputFormat(o.output),
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
      const o = program.opts<{ output?: string }>();
      try {
        await runTaskDelete(
          {
            apiUrl: opts.apiUrl,
            yes: true,
            format: resolveOutputFormat(o.output),
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
      const o = program.opts<{ output?: string }>();
      try {
        await runTaskComplete(
          {
            apiUrl: opts.apiUrl,
            format: resolveOutputFormat(o.output),
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
        const o = program.opts<{ output?: string }>();
        try {
          await runTaskMove(
            {
              apiUrl: opts.apiUrl,
              columnId: cmdOpts.column,
              status: cmdOpts.status as TaskStatus | undefined,
              format: resolveOutputFormat(o.output),
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

  // ---- tasks batch ----
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
        const o = program.opts<{ output?: string }>();
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
            format: resolveOutputFormat(o.output),
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
        const o = program.opts<{ output?: string }>();
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
            format: resolveOutputFormat(o.output),
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
        const o = program.opts<{ output?: string }>();
        try {
          const fromFile = cmdOpts.file ? await parseIdsFile(cmdOpts.file) : [];
          const allIds = [...ids, ...fromFile];
          await runTasksBatchDelete({
            apiUrl: opts.apiUrl,
            ids: allIds,
            yes: true,
            format: resolveOutputFormat(o.output),
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

  // ---- drafts ----
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
      const o = program.opts<{ output?: string }>();
      try {
        await runDraftsList({
          apiUrl: opts.apiUrl,
          boardId: cmdOpts.board,
          format: resolveOutputFormat(o.output),
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
      const o = program.opts<{ output?: string }>();
      try {
        await runDraftsPublish(
          {
            apiUrl: opts.apiUrl,
            format: resolveOutputFormat(o.output),
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
      const o = program.opts<{ output?: string }>();
      try {
        await runDraftsUnpublish(
          {
            apiUrl: opts.apiUrl,
            format: resolveOutputFormat(o.output),
            http,
          },
          id
        );
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(draftsExitCode(err));
      }
    });

  // ---- archived ----
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
      const o = program.opts<{ output?: string }>();
      try {
        await runArchivedList({
          apiUrl: opts.apiUrl,
          boardId: cmdOpts.board,
          format: resolveOutputFormat(o.output),
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
      const o = program.opts<{ output?: string }>();
      try {
        await runArchivedArchive(
          {
            apiUrl: opts.apiUrl,
            yes: true,
            format: resolveOutputFormat(o.output),
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
      const o = program.opts<{ output?: string }>();
      try {
        await runArchivedRestore(
          {
            apiUrl: opts.apiUrl,
            format: resolveOutputFormat(o.output),
            http,
          },
          id
        );
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(archivedExitCode(err));
      }
    });

  // ---- comments ----
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
      const o = program.opts<{ output?: string }>();
      try {
        await runCommentsAdd(
          {
            apiUrl: opts.apiUrl,
            body: cmdOpts.body,
            author: cmdOpts.author,
            format: resolveOutputFormat(o.output),
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
      const o = program.opts<{ output?: string }>();
      try {
        await runCommentsList(
          {
            apiUrl: opts.apiUrl,
            format: resolveOutputFormat(o.output),
            http,
          },
          taskId
        );
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(commentsExitCode(err));
      }
    });

  // ---- subtasks ----
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
      const o = program.opts<{ output?: string }>();
      try {
        await runSubtasksList(
          {
            apiUrl: opts.apiUrl,
            format: resolveOutputFormat(o.output),
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
      const o = program.opts<{ output?: string }>();
      try {
        await runSubtasksCreate(
          {
            apiUrl: opts.apiUrl,
            title: cmdOpts.title,
            format: resolveOutputFormat(o.output),
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
        const o = program.opts<{ output?: string }>();
        try {
          await runSubtasksUpdate(
            {
              apiUrl: opts.apiUrl,
              title: cmdOpts.title,
              completed: cmdOpts.completed,
              format: resolveOutputFormat(o.output),
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
      const o = program.opts<{ output?: string }>();
      try {
        await runSubtasksDelete(
          {
            apiUrl: opts.apiUrl,
            yes: true,
            format: resolveOutputFormat(o.output),
            http,
          },
          id
        );
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(subtasksExitCode(err));
      }
    });

  // ---- mine ----
  const mineCmd = program
    .command("mine")
    .description("list tasks assigned to (or routed to) the current agent (GET /api/v1/mcp/my-tasks)")
    .option("--board <id>", "client-side filter: only include tasks from this board")
    .option(
      "--lightweight",
      "return only id/title/priority/assignee/createdAt",
      false
    );

  function mineExitCode(err: unknown): number {
    if (err instanceof TasksInvalidUsageError) return 1;
    if (err instanceof TasksNotLoggedInError) return authExitCodeForError(err);
    return authExitCodeForError(err);
  }

  mineCmd.action(
    async (cmdOpts: { board?: string; lightweight?: boolean }) => {
      const o = program.opts<{ output?: string }>();
      try {
        await runMine({
          apiUrl: opts.apiUrl,
          boardId: cmdOpts.board,
          lightweight: cmdOpts.lightweight,
          format: resolveOutputFormat(o.output),
          http,
        });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(mineExitCode(err));
      }
    }
  );

  // ---- run ----
  // Long-lived runner loop that watches a board/column (mode-1) or the
  // agent's task inbox (mode-2) and dispatches each task to an external
  // agent binary. SIGINT / SIGTERM trigger a graceful drain so the
  // runner releases its locks before exiting.
  //
  // `run` is a parent command with two subcommands:
  //
  //   * `run start` — the actual runner loop (was the top-level
  //     `kanban run` command before the wizard was added).
  //   * `run init`  — interactive wizard for the `.kanban-runner.yaml`.
  //
  // Commander invokes the parent's default action when no subcommand
  // is matched, so `kanban run --config foo` still works exactly as it
  // did before — the `start` action and the parent default action are
  // wired to the same handler.
  const runCmd = program
    .command("run")
    .description(
      "run the runner loop (start) or scaffold its config (init)"
    )
    .option(
      "--config <file>",
      "explicit path to a .kanban-runner{.local}.yaml; overrides the discovery walk-up"
    )
    .option(
      "--board <id>",
      "mode-1 board id to watch (must pair with --status)"
    )
    .option(
      "--status <status>",
      "mode-1 column status to watch (todo|in_progress|review|done); must pair with --board"
    )
    .option(
      "--mine",
      "mode-2: pick tasks assigned to (or routed to) the authenticated agent"
    )
    .option(
      "--once",
      "process a single task and exit; useful for cron / smoke tests"
    );

  const runStartAction = async (cmdOpts: {
    config?: string;
    board?: string;
    status?: string;
    mine?: boolean;
    once?: boolean;
  }): Promise<void> => {
    try {
      await runRunCommand(
        {
          apiUrl: opts.apiUrl,
          profile: opts.profile,
          configPath: cmdOpts.config,
          boardId: cmdOpts.board,
          status: cmdOpts.status,
          mine: cmdOpts.mine === true,
          once: cmdOpts.once === true,
        },
        {
          http,
          oauth,
          cwd: process.cwd(),
        }
      );
    } catch (err) {
      if (err instanceof RunInvalidUsageError) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(1);
      }
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(exitCodeForError(err));
    }
  };

  // Default `kanban run <flags>` invocation still works because
  // Commander calls the parent's action when no subcommand matches.
  runCmd.action(runStartAction);

  runCmd
    .command("start")
    .description(
      "start the runner loop (claim → spawn agent → heartbeat → finish)"
    )
    .option(
      "--config <file>",
      "explicit path to a .kanban-runner{.local}.yaml; overrides the discovery walk-up"
    )
    .option(
      "--board <id>",
      "mode-1 board id to watch (must pair with --status)"
    )
    .option(
      "--status <status>",
      "mode-1 column status to watch (todo|in_progress|review|done); must pair with --board"
    )
    .option(
      "--mine",
      "mode-2: pick tasks assigned to (or routed to) the authenticated agent"
    )
    .option(
      "--once",
      "process a single task and exit; useful for cron / smoke tests"
    )
    .action(runStartAction);

  // ---- run init ----
  // Interactive wizard that writes a `.kanban-runner{.local}.yaml`
  // step-by-step. Subcommand of `run` so the existing `kanban run`
  // flag surface stays untouched.
  runCmd
    .command("init")
    .description(
      "interactively create a .kanban-runner{.local}.yaml (mode, agent, runner)"
    )
    .action(async () => {
      try {
        await runRunnerInitCommand(
          {
            cwd: process.cwd(),
            apiUrl: opts.apiUrl,
            profile: opts.profile,
            prompter: {
              select: <T,>(cfg: {
                message: string;
                choices: Array<{ value: T; name?: string; description?: string }>;
                default?: T;
              }): Promise<T> =>
                inquirerSelect(
                  cfg as Parameters<typeof inquirerSelect>[0]
                ) as Promise<T>,
              input: (cfg: {
                message: string;
                default?: string;
                validate?: (value: string) => string | true;
              }): Promise<string> => inquirerInput(cfg as Parameters<typeof inquirerInput>[0]),
              number: (cfg: {
                message: string;
                default?: number;
                min?: number;
                validate?: (value: number | undefined) => string | true;
              }): Promise<number | undefined> =>
                inquirerNumber(
                  cfg as Parameters<typeof inquirerNumber>[0]
                ) as Promise<number | undefined>,
              confirm: (cfg: {
                message: string;
                default?: boolean;
              }): Promise<boolean> => inquirerConfirm(cfg as Parameters<typeof inquirerConfirm>[0]),
            },
          },
          { http }
        );
      } catch (err) {
        if (err instanceof RunInitError) {
          process.stderr.write(`${(err as Error).message}\n`);
          process.exit(1);
        }
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(exitCodeForError(err));
      }
    });

  // ---- workspace ----
  const workspaceCmd = program
    .command("workspace")
    .description("manage workspace files");

  function workspaceExitCode(err: unknown): number {
    if (err instanceof TasksInvalidUsageError) return 1;
    if (err instanceof TasksNotLoggedInError) return authExitCodeForError(err);
    return authExitCodeForError(err);
  }

  workspaceCmd
    .command("upload <file>")
    .description(
      "upload a local text file to the workspace (POST /api/v1/workspace/upload)"
    )
    .option(
      "--path <remotePath>",
      "workspace-relative path for the uploaded file (defaults to the local basename)"
    )
    .action(async (file: string, cmdOpts: { path?: string }) => {
      const o = program.opts<{ output?: string }>();
      try {
        await runWorkspaceUpload({
          apiUrl: opts.apiUrl,
          file,
          remotePath: cmdOpts.path,
          format: resolveOutputFormat(o.output),
          http,
        });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(workspaceExitCode(err));
      }
    });

  workspaceCmd
    .command("batch-upload <files...>")
    .description(
      "upload multiple local text files in one request (POST /api/v1/workspace/batch-upload)"
    )
    .action(async (files: string[]) => {
      const o = program.opts<{ output?: string }>();
      try {
        await runWorkspaceBatchUpload({
          apiUrl: opts.apiUrl,
          files,
          format: resolveOutputFormat(o.output),
          http,
        });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(workspaceExitCode(err));
      }
    });

  workspaceCmd
    .command("list")
    .description("list workspace files (GET /api/v1/workspace/files)")
    .option("--path <sub>", "filter to a workspace-relative subdirectory")
    .action(async (cmdOpts: { path?: string }) => {
      const o = program.opts<{ output?: string }>();
      try {
        await runWorkspaceList({
          apiUrl: opts.apiUrl,
          path: cmdOpts.path,
          format: resolveOutputFormat(o.output),
          http,
        });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(workspaceExitCode(err));
      }
    });

  workspaceCmd
    .command("read <id>")
    .description(
      "read a workspace file (GET /api/v1/workspace/files/<id>); default writes the raw content to stdout, --output json emits a base64 payload"
    )
    .action(async (id: string) => {
      const o = program.opts<{ output?: string }>();
      try {
        await runWorkspaceRead(
          {
            apiUrl: opts.apiUrl,
            format: resolveOutputFormat(o.output),
            http,
          },
          id
        );
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(workspaceExitCode(err));
      }
    });

  workspaceCmd
    .command("delete <id>")
    .description(
      "delete a workspace file (DELETE /api/v1/workspace/files/<id>); --yes is the default"
    )
    .option("--yes", "skip confirmation prompt (default behaviour)", false)
    .action(async (id: string, _cmdOpts: { yes?: boolean }) => {
      const o = program.opts<{ output?: string }>();
      try {
        await runWorkspaceDelete(
          {
            apiUrl: opts.apiUrl,
            yes: true,
            format: resolveOutputFormat(o.output),
            http,
          },
          id
        );
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(workspaceExitCode(err));
      }
    });

  workspaceCmd
    .command("stats")
    .description("show workspace stats (GET /api/v1/workspace/stats)")
    .action(async () => {
      const o = program.opts<{ output?: string }>();
      try {
        await runWorkspaceStats({
          apiUrl: opts.apiUrl,
          format: resolveOutputFormat(o.output),
          http,
        });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(workspaceExitCode(err));
      }
    });

  // ---- shell ----
  program
    .command("shell")
    .description(
      "start an interactive REPL; type `exit` (or Ctrl-D) to leave"
    )
    .action(async () => {
      await runShell(
        { apiUrl: opts.apiUrl, profile: opts.profile },
        {
          program,
          oauth,
          http,
          input: process.stdin,
          output: process.stdout,
          errorOutput: process.stderr,
        }
      );
    });

  // ---- completion ----
  // Emits a self-contained bash/zsh/fish completion snippet on stdout.
  // The hidden `__complete <line>` command is invoked by the script to
  // fetch dynamic ids; it stays hidden from `--help` so users don't
  // stumble on it.
  const completionCmd = program
    .command("completion")
    .description("emit a shell completion script (bash|zsh|fish)");

  completionCmd
    .command("bash")
    .description("emit a bash completion script to stdout")
    .action(() => {
      try {
        runCompletion({ shell: "bash" });
      } catch (err) {
        if (err instanceof UnsupportedShellError) {
          process.stderr.write(`${(err as Error).message}\n`);
          process.exit(1);
        }
        throw err;
      }
    });

  completionCmd
    .command("zsh")
    .description("emit a zsh completion script to stdout")
    .action(() => {
      try {
        runCompletion({ shell: "zsh" });
      } catch (err) {
        if (err instanceof UnsupportedShellError) {
          process.stderr.write(`${(err as Error).message}\n`);
          process.exit(1);
        }
        throw err;
      }
    });

  completionCmd
    .command("fish")
    .description("emit a fish completion script to stdout")
    .action(() => {
      try {
        runCompletion({ shell: "fish" });
      } catch (err) {
        if (err instanceof UnsupportedShellError) {
          process.stderr.write(`${(err as Error).message}\n`);
          process.exit(1);
        }
        throw err;
      }
    });

  // Hidden `__complete` endpoint used by the completion scripts to
  // resolve dynamic ids (boardId / columnId / taskId / ...). The
  // `<line> <point>` invocation mirrors the convention popularised by
  // kubectl and gh: the script passes the full line plus the cursor
  // offset so partial tokens don't get treated as completed words.
  const completeCmd = program
    .command("__complete <line> [point]")
    .description("internal: dynamic completion used by the shell scripts")
    .action(async (line: string, pointRaw?: string) => {
      const point = pointRaw !== undefined ? Number(pointRaw) : undefined;
      try {
        await runComplete({
          line,
          point,
          apiUrl: opts.apiUrl,
          http,
        });
      } catch {
        // Dynamic completion is best-effort; the script keeps working
        // with static candidates even when the network is down.
      }
    });
  // Hide __complete from --help so end users don't see the protocol.
  (completeCmd as unknown as { _hidden: boolean })._hidden = true;

  // ---- config ----
  // Inspects and updates the persistent CLI configuration. The priority
  // chain (CLI flag > env var > config file > built-in default) is owned
  // by `commands/config.ts`; the command group just wires the two user-
  // facing verbs (`get` / `set`) to that module.
  const configCmd = program
    .command("config")
    .description("view or update CLI configuration (API URL, profile, output, timeout)");

  configCmd
    .command("get [key]")
    .description(
      "print the effective value for <key> (apiUrl|output|profile|timeout); with no key, prints every supported key alongside its source"
    )
    .action(async (key?: string) => {
      // We scan the original argv instead of reading program.opts()
      // because Commander reports the *default* value (the resolved
      // apiUrl/profile) when the user did not pass the flag — that
      // would always show source=cli and hide the env/file/default
      // chain. `extractCliFlags` returns only the flags the user
      // explicitly typed.
      const cliFlags = extractCliFlags(process.argv);
      try {
        await runConfigGet({ key, cliFlags });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        if (
          err instanceof InvalidConfigKeyError ||
          err instanceof InvalidConfigValueError
        ) {
          process.exit(1);
        }
        process.exit(exitCodeForError(err));
      }
    });

  configCmd
    .command("set <key> <value>")
    .description(
      "write <key>=<value> to ~/.config/kanban-cli/config.json; supported keys: apiUrl, output, profile, timeout"
    )
    .action(async (key: string, value: string) => {
      try {
        await runConfigSet({ key, value });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        if (
          err instanceof InvalidConfigKeyError ||
          err instanceof InvalidConfigValueError
        ) {
          process.exit(1);
        }
        process.exit(exitCodeForError(err));
      }
    });

  return program;
}

export { resolveRootConfig } from "./config.js";