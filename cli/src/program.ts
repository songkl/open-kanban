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
  runPasswordLogin,
  runStatus as runAuthStatus,
  runWhoami,
  InvalidUsageError as AuthInvalidUsageError,
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
  runTaskAdvance,
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
import { runRunsList, InvalidUsageError as RunsInvalidUsageError } from "./commands/runs.js";
import { runAttach, InvalidUsageError as AttachInvalidUsageError } from "./commands/attach.js";
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
  runAgentLogin,
} from "./commands/agents.js";
import { t } from "./i18n/index.js";

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

// ResolveLoginModeDeps keeps the @inquirer/prompts surface injectable so
// the identity-picker logic in program.ts stays unit-testable without
// pulling in a TTY. ProgramDeps already wires the default; tests pass
// a fake prompt to drive the deterministic branches.
export interface ResolveLoginModeDeps {
  prompt?: <T>(message: string, choices: Array<{ value: T; name?: string; description?: string }>, defaultValue?: T) => Promise<T>;
  stdin?: NodeJS.ReadableStream;
}

// resolveLoginMode decides which LoginMode `auth login` should use.
// The historical defaults (s-1231) stay in place: --as-human forces
// the human-binding flow, --as-agent forces the agent-binding flow,
// and any other flag-less invocation defaults to 'agent' so non-TTY
// callers (CI scripts, the e2e agent-selection suite) keep working.
//
// s-1246 adds the interactive branch: when stdin is a TTY and no mode
// flag was supplied, surface a selector so the operator can pick
// between binding to themselves (Human) and binding to an Agent. The
// selector defaults to 'agent' to keep the unattended-runner use case
// one keystroke away from the previous behaviour.
export async function resolveLoginMode(
  cmdOpts: { asHuman?: boolean; asAgent?: boolean },
  deps: ResolveLoginModeDeps = {}
): Promise<"human" | "agent"> {
  if (cmdOpts.asHuman) return "human";
  if (cmdOpts.asAgent) return "agent";
  const stdin = deps.stdin ?? process.stdin;
  const isInteractive =
    stdin && (stdin as { isTTY?: boolean }).isTTY === true;
  if (!isInteractive) return "agent";
  const prompt = deps.prompt;
  if (!prompt) return "agent";
  const choice = await prompt<"human" | "agent">(
    t("cli.auth.login.prompt.identity"),
    [
      {
        value: "agent",
        name: t("cli.auth.login.prompt.identity.agent"),
        description: t("cli.auth.login.prompt.identity.agentDesc"),
      },
      {
        value: "human",
        name: t("cli.auth.login.prompt.identity.human"),
        description: t("cli.auth.login.prompt.identity.humanDesc"),
      },
    ],
    "agent"
  );
  return choice;
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
    .description(t("cli.description"))
    .version(version)
    .option("--api-url <url>", t("cli.option.apiUrl"), opts.apiUrl)
    .option("--profile <name>", t("cli.option.profile"), opts.profile)
    .option("--output <format>", t("cli.option.output"), "table")
    .option("--no-color", t("cli.option.noColor"))
    .option("--color <mode>", t("cli.option.color"), "auto")
    .option("--lang <locale>", t("cli.option.lang"));

  // Apply the resolved colour override once, after Commander has parsed
  // argv. Doing it here keeps every command file agnostic of Commander.
  program.hook("preAction", () => {
    const o = program.opts<{ color?: unknown }>();
    setColorOverride(parseColorFlag(o.color));
  });

  // ---- auth ----
  const authCmd = program.command("auth").description(t("cli.auth.description"));

  authCmd
    .command("login")
    .description(t("cli.auth.login.description"))
    .option("--as-human", t("cli.auth.login.opt.asHuman"))
    .option("--as-agent", t("cli.auth.login.opt.asAgent"))
    .option("--no-open", t("cli.auth.login.opt.noOpen"))
    .option("--user <username>", t("cli.auth.login.opt.user"))
    .option("--password <password>", t("cli.auth.login.opt.password"))
    .option("--password-stdin", t("cli.auth.login.opt.passwordStdin"))
    .action(
      async (cmdOpts: {
        asHuman?: boolean;
        asAgent?: boolean;
        open?: boolean;
        user?: string;
        password?: string;
        passwordStdin?: boolean;
      }) => {
        try {
          // s-1275: the --user/--password shortcut bypasses the OAuth
          // device flow entirely. Reject mixing with the device-flow
          // mode flags so the operator doesn't accidentally trigger
          // both paths.
          const wantsPasswordLogin =
            Boolean(cmdOpts.user) ||
            Boolean(cmdOpts.password) ||
            cmdOpts.passwordStdin === true ||
            Boolean(process.env.KANBAN_CLI_PASSWORD);
          if (wantsPasswordLogin) {
            if (cmdOpts.asHuman || cmdOpts.asAgent) {
              process.stderr.write(
                `${t("cli.auth.login.err.mixPasswordWithMode")}\n`
              );
              process.exit(1);
            }
            const username = cmdOpts.user?.trim();
            if (!username) {
              process.stderr.write(
                `${t("cli.auth.login.err.missingUser")}\n`
              );
              process.exit(1);
            }
            let password = cmdOpts.password ?? "";
            if (!password && cmdOpts.passwordStdin === true) {
              const stdin = process.stdin;
              stdin.setEncoding("utf8");
              const chunks: string[] = [];
              const readAll = async (): Promise<string> =>
                new Promise<string>((resolve, reject) => {
                  const onEnd = (): void => resolve(chunks.join(""));
                  const onError = (err: Error): void => reject(err);
                  stdin.once("end", onEnd);
                  stdin.once("error", onError);
                  stdin.on("data", (chunk: string) => {
                    chunks.push(chunk);
                    // Honour the "first line is the password"
                    // convention so `echo pw | kanban auth login ...`
                    // doesn't accidentally swallow trailing input.
                    if (chunk.includes("\n")) {
                      const idx = chunks.join("").indexOf("\n");
                      const full = chunks.join("");
                      stdin.removeListener("data", () => {});
                      stdin.removeListener("end", onEnd);
                      stdin.removeListener("error", onError);
                      resolve(full.slice(0, idx));
                    }
                  });
                });
              password = (await readAll()).trimEnd();
            }
            if (!password && process.env.KANBAN_CLI_PASSWORD) {
              password = process.env.KANBAN_CLI_PASSWORD;
            }
            await runPasswordLogin(
              {
                apiUrl: opts.apiUrl,
                profile: opts.profile,
                username,
                password,
              },
              { oauth }
            );
            return;
          }
          if (cmdOpts.asHuman && cmdOpts.asAgent) {
            process.stderr.write(
              `${t("cli.auth.login.err.mixAsHumanAsAgent")}\n`
            );
            process.exit(1);
          }
          const mode = await resolveLoginMode(cmdOpts, {
            prompt: async (message, choices, defaultValue) =>
              inquirerSelect({
                message,
                choices,
                default: defaultValue,
              }),
          });
          await runLogin(
            {
              apiUrl: opts.apiUrl,
              profile: opts.profile,
              mode,
              openBrowser: cmdOpts.open !== false,
            },
            { oauth, http }
          );
        } catch (err) {
          if (err instanceof AuthInvalidUsageError) {
            process.stderr.write(`${(err as Error).message}\n`);
            process.exit(1);
          }
          process.stderr.write(`${(err as Error).message}\n`);
          process.exit(authExitCodeForError(err));
        }
      }
    );

  authCmd
    .command("status")
    .description(t("cli.auth.status.description"))
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
    .description(t("cli.auth.logout.description"))
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
    .description(t("cli.auth.whoami.description"))
    .option("--path <path>", t("cli.auth.whoami.opt.path"), "/api/v1/users/me")
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

  const agentCmd = authCmd
    .command("agent")
    .description(t("cli.auth.agent.description"));

  agentCmd
    .command("list")
    .description(t("cli.auth.agent.list.description"))
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
    .description(t("cli.auth.agent.create.description"))
    .option("--avatar <url>", t("cli.auth.agent.create.opt.avatar"))
    .option("--role <role>", t("cli.auth.agent.create.opt.role"), "ADMIN")
    .option("--no-bind", t("cli.auth.agent.create.opt.noBind"))
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
              `${t("cli.auth.agent.create.err.invalidRole", {
                value: String(cmdOpts.role),
              })}\n`
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
    .description(t("cli.auth.agent.bind.description"))
    .option("--token <token>", t("cli.auth.agent.bind.opt.token"))
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
              message: t("cli.auth.agent.bind.prompt.token"),
              validate: (v: string) =>
                v && v.trim().length > 0
                  ? true
                  : t("cli.auth.agent.bind.prompt.tokenRequired"),
            }),
        });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(exitCodeForError(err));
      }
    });

  // `kanban auth agent login` opens the OAuth device authorization
  // page so the human approver can pick "bind existing Agent" or
  // "create new Agent" on the approval screen, then validates the
  // resulting token is bound to a type='AGENT' user before persisting
  // it under the agent-token marker. Complements `auth login` (which
  // binds the human approver by default; pass --as-agent to bind to
  // an Agent, or pick "Agent" in the interactive picker on a TTY —
  // s-1246) and `auth agent {create,bind}` (which require admin or a
  // pre-issued token).
  agentCmd
    .command("login")
    .description(t("cli.auth.agent.login.description"))
    .option("--no-open", t("cli.auth.agent.login.opt.noOpen"))
    .action(async (cmdOpts: { open?: boolean }) => {
      const o = program.opts<{ output?: string }>();
      try {
        await runAgentLogin({
          apiUrl: opts.apiUrl,
          format: resolveOutputFormat(o.output),
          http,
          oauth,
          openBrowser: cmdOpts.open !== false,
        });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(exitCodeForError(err));
      }
    });

  agentCmd
    .command("delete <agentId>")
    .description(t("cli.auth.agent.delete.description"))
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
    .description(t("cli.status.description"))
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
    .description(t("cli.dashboard.description"))
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
  const boardsCmd = program.command("boards").description(t("cli.boards.description"));

  boardsCmd
    .command("list")
    .description(t("cli.boards.list.description"))
    .option("--fields <fields>", t("cli.boards.list.opt.fields"), (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean))
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
    .description(t("cli.boards.get.description"))
    .option("--fields <fields>", t("cli.boards.get.opt.fields"), (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean))
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
  const columnsCmd = program.command("columns").description(t("cli.columns.description"));

  columnsCmd
    .command("list")
    .description(t("cli.columns.list.description"))
    .option("--board <id>", t("cli.columns.list.opt.board"))
    .option(
      "--positions <list>",
      t("cli.columns.list.opt.positions"),
      (v: string) =>
        v
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n))
    )
    .option(
      "--fields <fields>",
      t("cli.columns.list.opt.fields"),
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
    .description(t("cli.columns.get.description"))
    .option(
      "--fields <fields>",
      t("cli.columns.get.opt.fields"),
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
  const tasksCmd = program.command("tasks").description(t("cli.tasks.description"));

  function tasksExitCode(err: unknown): number {
    if (err instanceof TasksInvalidUsageError) return 1;
    if (err instanceof TasksNotLoggedInError) return authExitCodeForError(err);
    return authExitCodeForError(err);
  }

  tasksCmd
    .command("list")
    .description(t("cli.tasks.list.description"))
    .option("--board <id>", t("cli.tasks.list.opt.board"))
    .option("--column <id>", t("cli.tasks.list.opt.column"))
    .option("--status <status>", t("cli.tasks.list.opt.status"))
    .option("--agent-type <type>", t("cli.tasks.list.opt.agentType"))
    .option("--priority <priority>", t("cli.tasks.list.opt.priority"))
    .option("--assignee <username>", t("cli.tasks.list.opt.assignee"))
    .option("--search <query>", t("cli.tasks.list.opt.search"))
    .option("--since <range>", t("cli.tasks.list.opt.since"))
    .option("--tag <tag>", t("cli.tasks.list.opt.tag"))
    .option("--lightweight", t("cli.tasks.list.opt.lightweight"), false)
    .option(
      "--fields <set>",
      t("cli.tasks.list.opt.fields"),
      (v: string): TaskFields => {
        const localT = v.trim();
        if (localT !== "id" && localT !== "id+updated") {
          throw new TasksInvalidUsageError(
            t("cli.tasks.list.err.invalidFields", { value: v })
          );
        }
        return localT as TaskFields;
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
    .description(t("cli.tasks.get.description"))
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
    .description(t("cli.tasks.create.description"))
    .requiredOption("--title <title>", t("cli.tasks.create.opt.title"))
    .option("--description <description>", t("cli.tasks.create.opt.description"))
    .option("--column <id>", t("cli.tasks.create.opt.column"))
    .option("--status <status>", t("cli.tasks.create.opt.status"))
    .option("--board <id>", t("cli.tasks.create.opt.board"))
    .option("--priority <priority>", t("cli.tasks.create.opt.priority"))
    .option("--assignee <username>", t("cli.tasks.create.opt.assignee"))
    .option("--meta <kv...>", t("cli.tasks.create.opt.meta"))
    .option("--no-publish", t("cli.tasks.create.opt.noPublish"))
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
    .description(t("cli.tasks.update.description"))
    .option("--title <title>", t("cli.tasks.update.opt.title"))
    .option("--description <description>", t("cli.tasks.update.opt.description"))
    .option("--priority <priority>", t("cli.tasks.update.opt.priority"))
    .option("--assignee <username>", t("cli.tasks.update.opt.assignee"))
    .option("--meta <kv...>", t("cli.tasks.update.opt.meta"))
    .option("--column <id>", t("cli.tasks.update.opt.column"))
    .option("--status <status>", t("cli.tasks.update.opt.status"))
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
    .description(t("cli.tasks.delete.description"))
    .option("--yes", t("cli.tasks.delete.opt.yes"), false)
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
    .description(t("cli.tasks.complete.description"))
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
    .command("advance <id>")
    .description(t("cli.tasks.advance.description"))
    .action(async (id: string) => {
      const o = program.opts<{ output?: string }>();
      try {
        await runTaskAdvance(
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
    .description(t("cli.tasks.move.description"))
    .option("--column <id>", t("cli.tasks.move.opt.column"))
    .option("--status <status>", t("cli.tasks.move.opt.status"))
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
    .description(t("cli.tasks.batch.description"));

  function tasksBatchExitCode(err: unknown): number {
    if (err instanceof TasksInvalidUsageError) return 1;
    if (err instanceof TasksNotLoggedInError) return authExitCodeForError(err);
    return authExitCodeForError(err);
  }

  tasksBatchCmd
    .command("create")
    .description(t("cli.tasks.batch.create.description"))
    .option("--file <path>", t("cli.tasks.batch.create.opt.file"))
    .option("--title <title>", t("cli.tasks.batch.create.opt.title"), splitFlagValues)
    .option("--description <description>", t("cli.tasks.batch.create.opt.description"), splitFlagValues)
    .option("--column <id>", t("cli.tasks.batch.create.opt.column"), splitFlagValues)
    .option("--status <status>", t("cli.tasks.batch.create.opt.status"), splitFlagValues)
    .option("--priority <priority>", t("cli.tasks.batch.create.opt.priority"), splitFlagValues)
    .option("--assignee <username>", t("cli.tasks.batch.create.opt.assignee"), splitFlagValues)
    .option("--published", t("cli.tasks.batch.create.opt.published"), splitFlagValues)
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
    .description(t("cli.tasks.batch.update.description"))
    .option("--file <path>", t("cli.tasks.batch.update.opt.file"))
    .option("--column <id>", t("cli.tasks.batch.update.opt.column"))
    .option("--status <status>", t("cli.tasks.batch.update.opt.status"))
    .option("--priority <priority>", t("cli.tasks.batch.update.opt.priority"))
    .option("--assignee <username>", t("cli.tasks.batch.update.opt.assignee"))
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
    .description(t("cli.tasks.batch.delete.description"))
    .option("--file <path>", t("cli.tasks.batch.delete.opt.file"))
    .option("--yes", t("cli.tasks.batch.delete.opt.yes"), false)
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
      const localT = String(v).trim().toLowerCase();
      if (localT === "true" || localT === "1" || localT === "yes") return true;
      if (localT === "false" || localT === "0" || localT === "no") return false;
      throw new TasksInvalidUsageError(
        t("cli.tasks.batch.err.invalidBoolean", { value: v })
      );
    });
  }

  // ---- drafts ----
  const draftsCmd = program
    .command("drafts")
    .description(t("cli.drafts.description"));

  function draftsExitCode(err: unknown): number {
    if (err instanceof TasksInvalidUsageError) return 1;
    if (err instanceof TasksNotLoggedInError) return authExitCodeForError(err);
    return authExitCodeForError(err);
  }

  draftsCmd
    .command("list")
    .description(t("cli.drafts.list.description"))
    .option("--board <id>", t("cli.drafts.list.opt.board"))
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
    .description(t("cli.drafts.publish.description"))
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
    .description(t("cli.drafts.unpublish.description"))
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
  const archivedCmd = program
    .command("archived")
    .description(t("cli.archived.description"));

  function archivedExitCode(err: unknown): number {
    if (err instanceof TasksInvalidUsageError) return 1;
    if (err instanceof TasksNotLoggedInError) return authExitCodeForError(err);
    return authExitCodeForError(err);
  }

  archivedCmd
    .command("list")
    .description(t("cli.archived.list.description"))
    .option("--board <id>", t("cli.tasks.list.opt.board"))
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
    .description(t("cli.archived.archive.description"))
    .option("--yes", t("cli.tasks.delete.opt.yes"), false)
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
    .description(t("cli.archived.restore.description"))
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
  const commentsCmd = program
    .command("comments")
    .description(t("cli.comments.description"));

  function commentsExitCode(err: unknown): number {
    if (err instanceof TasksInvalidUsageError) return 1;
    if (err instanceof TasksNotLoggedInError) return authExitCodeForError(err);
    return authExitCodeForError(err);
  }

  commentsCmd
    .command("add <taskId>")
    .description(t("cli.comments.add.description"))
    .requiredOption(
      "--body <text>",
      `${t("cli.comments.add.opt.body")}, 或 "${STDIN_BODY_SENTINEL}" 从 stdin 读取`
    )
    .option("--author <name>", t("cli.comments.add.opt.author"))
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
    .description(t("cli.comments.list.description"))
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
  const subtasksCmd = program
    .command("subtasks")
    .description(t("cli.subtasks.description"));

  function subtasksExitCode(err: unknown): number {
    if (err instanceof TasksInvalidUsageError) return 1;
    if (err instanceof TasksNotLoggedInError) return authExitCodeForError(err);
    return authExitCodeForError(err);
  }

  subtasksCmd
    .command("list <taskId>")
    .description(t("cli.subtasks.list.description"))
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
    .description(t("cli.subtasks.create.description"))
    .requiredOption("--title <title>", t("cli.subtasks.create.opt.title"))
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
    .description(t("cli.subtasks.update.description"))
    .option("--title <title>", t("cli.tasks.update.opt.title"))
    .option(
      "--completed",
      t("cli.subtasks.update.opt.completed")
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
    .description(t("cli.subtasks.delete.description"))
    .option("--yes", t("cli.tasks.delete.opt.yes"), false)
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
    .description(t("cli.mine.description"))
    .option("--board <id>", t("cli.mine.opt.board"))
    .option(
      "--lightweight",
      t("cli.tasks.list.opt.lightweight"),
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
        // s-1275: when `runMine` already wrote a friendly "Not logged
        // in" line to stderr, do NOT also echo the error message —
        // which would otherwise be the internal OAuth refresh failure
        // ("failed to refresh access token: no refresh token
        // available"). The friendly line is the single user-facing
        // message; the exit code stays 2 (authExitCodeForError) so
        // shell scripts continue to detect the not-logged-in state.
        if (err instanceof TasksNotLoggedInError) {
          process.exit(mineExitCode(err));
        }
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
    .description(t("cli.run.description"))
    .option("--config <file>", t("cli.run.opt.config"))
    .option("--board <id>", t("cli.run.opt.board"))
    .option("--status <status>", t("cli.run.opt.status"))
    .option("--mine", t("cli.run.opt.mine"))
    .option("--once", t("cli.run.opt.once"))
    .option("--debug", t("cli.run.opt.debug"));

  const runStartAction = async (cmdOpts: {
    config?: string;
    board?: string;
    status?: string;
    mine?: boolean;
    once?: boolean;
    debug?: boolean;
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
          debug: cmdOpts.debug === true,
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
    .description(t("cli.run.start.description"))
    .option("--config <file>", t("cli.run.opt.config"))
    .option("--board <id>", t("cli.run.opt.board"))
    .option("--status <status>", t("cli.run.opt.status"))
    .option("--mine", t("cli.run.opt.mine"))
    .option("--once", t("cli.run.opt.once"))
    .option("--debug", t("cli.run.opt.debug"))
    .action(runStartAction);

  // ---- run init ----
  // Interactive wizard that writes a `.kanban-runner{.local}.yaml`
  // step-by-step. Subcommand of `run` so the existing `kanban run`
  // flag surface stays untouched.
  runCmd
    .command("init")
    .description(t("cli.run-init.description"))
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

  // ---- runs ----
  // Read-only listing of terminal task_runs rows (completed / failed /
  // released) backed by `GET /api/v1/runs/history`. Sits next to `run`
  // because the same operator that drives the runner loop also wants to
  // inspect what previous runs did — but is its own command group so
  // future per-run verbs (get, cancel, …) have an obvious home.
  const runsCmd = program
    .command("runs")
    .description(t("cli.runs.description"));

  function runsExitCode(err: unknown): number {
    if (err instanceof RunsInvalidUsageError) return 1;
    return authExitCodeForError(err);
  }

  runsCmd
    .command("list")
    .description(t("cli.runs.list.description"))
    .option("--runner-id <id>", t("cli.runs.list.opt.runnerId"))
    .option("--since <duration>", t("cli.runs.list.opt.since"))
    .option("--status <status>", t("cli.runs.list.opt.status"))
    .option("--task <id>", t("cli.runs.list.opt.task"))
    .option("--board <id>", t("cli.runs.list.opt.board"))
    .option(
      "--limit <n>",
      t("cli.runs.list.opt.limit"),
      (v: string) => {
        const n = Number(v);
        if (!Number.isFinite(n) || !Number.isInteger(n)) {
          throw new RunsInvalidUsageError(
            t("cli.runs.err.invalidLimit", { value: v })
          );
        }
        return n;
      }
    )
    .option(
      "--offset <n>",
      t("cli.runs.list.opt.offset"),
      (v: string) => {
        const n = Number(v);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
          throw new RunsInvalidUsageError(
            t("cli.runs.err.invalidOffset", { value: v })
          );
        }
        return n;
      }
    )
    .action(
      async (cmdOpts: {
        runnerId?: string;
        since?: string;
        status?: string;
        task?: string;
        board?: string;
        limit?: number;
        offset?: number;
      }) => {
        const o = program.opts<{ output?: string }>();
        try {
          await runRunsList({
            apiUrl: opts.apiUrl,
            runnerId: cmdOpts.runnerId,
            since: cmdOpts.since,
            status: cmdOpts.status,
            taskId: cmdOpts.task,
            boardId: cmdOpts.board,
            limit: cmdOpts.limit,
            offset: cmdOpts.offset,
            format: resolveOutputFormat(o.output),
            http,
          });
        } catch (err) {
          process.stderr.write(`${(err as Error).message}\n`);
          process.exit(runsExitCode(err));
        }
      }
    );

  // ---- attach ----
  // AI-first entry point. Where `kanban run --board X --status Y`
  // walks a column for the next eligible task, `kanban attach <id>`
  // claims one specific task by id. The runner identity defaults to
  // `<host>-<pid>-<uuid>` (the same format `kanban run` uses) so the
  // operator can hand the printed runnerId to a follow-up heartbeat /
  // finish curl without thinking about identity wiring.
  //
  // The endpoint enforces the same per-column WRITE permission as
  // ClaimRun, so a stolen token can't grab tasks on boards the
  // caller has no access to.
  program
    .command("attach <taskId>")
    .description(t("cli.attach.description"))
    .option("--runner-id <id>", t("cli.attach.opt.runnerId"))
    .option("--agent-type <type>", t("cli.attach.opt.agentType"))
    .option(
      "--lock-timeout-ms <ms>",
      t("cli.attach.opt.lockTimeoutMs"),
      (v: string) => {
        const n = Number(v);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
          throw new AttachInvalidUsageError(
            t("cli.attach.err.invalidLockTimeout", { value: v })
          );
        }
        return n;
      }
    )
    .option("--reason <text>", t("cli.attach.opt.reason"))
    .action(
      async (
        taskId: string,
        cmdOpts: {
          runnerId?: string;
          agentType?: string;
          lockTimeoutMs?: number;
          reason?: string;
        }
      ) => {
        const o = program.opts<{ output?: string }>();
        try {
          await runAttach({
            apiUrl: opts.apiUrl,
            taskId,
            runnerId: cmdOpts.runnerId,
            agentType: cmdOpts.agentType,
            lockTimeoutMs: cmdOpts.lockTimeoutMs,
            reason: cmdOpts.reason,
            format: resolveOutputFormat(o.output),
            http,
          });
        } catch (err) {
          if (err instanceof AttachInvalidUsageError) {
            process.stderr.write(`${(err as Error).message}\n`);
            process.exit(1);
          }
          process.stderr.write(`${(err as Error).message}\n`);
          process.exit(authExitCodeForError(err));
        }
      }
    );

  // ---- workspace ----
  const workspaceCmd = program
    .command("workspace")
    .description(t("cli.workspace.description"));

  function workspaceExitCode(err: unknown): number {
    if (err instanceof TasksInvalidUsageError) return 1;
    if (err instanceof TasksNotLoggedInError) return authExitCodeForError(err);
    return authExitCodeForError(err);
  }

  workspaceCmd
    .command("upload <file>")
    .description(t("cli.workspace.upload.description"))
    .option("--path <remotePath>", t("cli.workspace.upload.opt.path"))
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
    .description(t("cli.workspace.batch.description"))
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
    .description(t("cli.workspace.list.description"))
    .option("--path <sub>", t("cli.workspace.list.opt.path"))
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
    .description(t("cli.workspace.read.description"))
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
    .description(t("cli.workspace.delete.description"))
    .option("--yes", t("cli.tasks.delete.opt.yes"), false)
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
    .description(t("cli.workspace.stats.description"))
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
    .description(t("cli.shell.description"))
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
    .description(t("cli.completion.description"));

  completionCmd
    .command("bash")
    .description(t("cli.completion.bash.description"))
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
    .description(t("cli.completion.zsh.description"))
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
    .description(t("cli.completion.fish.description"))
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
    .description(t("cli.complete.description"))
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
    .description(t("cli.config.description"));

  configCmd
    .command("get [key]")
    .description(t("cli.config.get.description"))
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
    .description(t("cli.config.set.description"))
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