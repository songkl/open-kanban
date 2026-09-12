// `kanban auth agent` sub-commands.
//
// The CLI's `auth login` runs the OAuth device flow, which binds the
// eventual access token to the human approver. That is wrong for the
// unattended runner / automation use case: a long-running process needs a
// stable AGENT identity (type='AGENT' on the server) so that audit
// trails, board permissions and the /mcp/my-tasks filter all reflect the
// automating account rather than whichever admin clicked "approve" in
// the browser.
//
// The commands in this module close that gap:
//
//   kanban auth agent list
//       GET  /api/v1/auth/agents  → tabular listing (admin only)
//
//   kanban auth agent create <nickname>
//       POST /api/v1/auth/agents  → returns { agent, token }
//       The returned token is written to the CLI's encrypted credential
//       store so every subsequent `kanban ...` call runs as the new
//       Agent (admin only — required by the backend)
//
//   kanban auth agent bind [--token <token>]
//       Takes a pre-existing Agent API token (from the Settings → Agents
//       page, or copy-pasted from `kanban auth agent create`'s output)
//       and writes it to the credential store. The token is validated by
//       calling GET /api/v1/users/me; if the resolved user is not of
//       type='AGENT' the CLI refuses to bind so it cannot accidentally
//       downgrade an admin session to a HUMAN token.
//
//   kanban auth agent delete <agentId>
//       DELETE /api/v1/auth/agents?id=<agentId>  (admin only)
//
// `auth agent create` and `auth agent bind` share a small helper
// (writeAgentToken) so the credential-store mechanics live in one place.

import chalk from "chalk";
import Table from "cli-table3";
import { HttpClient, AuthError, NotFoundError, ApiError } from "../http/client.js";
import { InvalidUsageError } from "./boards.js";
import { NotLoggedInError } from "./dashboard.js";
import { formatStructured } from "../output/format.js";
import { OAuthClient } from "../auth/client.js";
import type { StoredCredentials } from "../auth/token-store.js";

export type OutputFormat = "table" | "json" | "yaml";

// AgentRecord mirrors the JSON shape returned by GET /api/v1/auth/agents
// and the `agent` field of POST /api/v1/auth/agents. We only consume the
// fields we display / echo; the rest pass through as unknown.
export interface AgentRecord {
  id?: string;
  nickname?: string;
  username?: string;
  avatar?: string;
  type?: string;
  role?: string;
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
  lastActiveAt?: string;
  tokenCount?: number;
  // `token` is returned only by POST /api/v1/auth/agents and POST
  // /api/v1/auth/agents/reset-token; agents-list omits it.
  token?: string;
}

export interface AgentsReport {
  apiUrl: string;
  agents: AgentRecord[];
}

export interface AgentCreateResult {
  apiUrl: string;
  agent: AgentRecord;
  // token is the freshly-minted API token. Returned so tests and
  // automation can capture it; the CLI also persists it via
  // writeAgentToken below.
  token: string;
  // bound is true when the new credential store was updated in place.
  // False when the caller passed an OAuth client (e.g. dry-run mode) or
  // when persistence failed.
  bound: boolean;
}

export interface AgentBindResult {
  apiUrl: string;
  agent: AgentRecord;
  bound: boolean;
}

export interface AgentDeleteResult {
  apiUrl: string;
  id: string;
  success: boolean;
}

// CLIENT_NAME_AGENT marks the credential-store entries written by
// runAgentCreate / runAgentBind. `auth status` reads this to render a
// "Agent-bound" hint so users can tell at a glance whether the local
// session is an OAuth-managed human session or a long-lived Agent
// token. See auth/commands.ts runStatus for the consumer.
export const CLIENT_NAME_AGENT = "kanban-cli/agent-token";

export interface RunAgentsListOptions {
  apiUrl: string;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface RunAgentCreateOptions {
  apiUrl: string;
  nickname: string;
  avatar?: string;
  role?: "ADMIN" | "MEMBER" | "VIEWER";
  // bindWhenFinished (default: true) toggles whether the freshly
  // minted token is persisted to the local credential store. Tests can
  // pass false to inspect the raw agent record + token without
  // touching disk / the InMemorySecretProvider.
  bindWhenFinished?: boolean;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
  oauth: OAuthClient;
}

export interface RunAgentBindOptions {
  apiUrl: string;
  token?: string;
  // envToken reads KANBAN_AGENT_TOKEN when set; the flag takes
  // precedence. Useful for CI / systemd units that store the token in
  // a secret manager.
  envToken?: string;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
    stdin?: NodeJS.ReadableStream;
  };
  http: HttpClient;
  oauth: OAuthClient;
  // prompt is consulted when neither --token nor envToken yielded a
  // value. The CLI wires @inquirer/prompts' password input; tests pass
  // a stub that returns a canned string.
  prompt?: () => Promise<string>;
}

export interface RunAgentDeleteOptions {
  apiUrl: string;
  format?: OutputFormat;
  yes?: boolean;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

// runAgentsList GETs /api/v1/auth/agents and renders the result as a
// table (id / nickname / role / enabled / lastActive). Empty list
// surfaces the same "(no agents)" hint the other list commands use.
export async function runAgentsList(
  opts: RunAgentsListOptions
): Promise<AgentsReport> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  let raw: { agents?: AgentRecord[] } | AgentRecord[];
  try {
    raw = await opts.http.apiGet<{ agents?: AgentRecord[] } | AgentRecord[]>(
      "/api/v1/auth/agents"
    );
  } catch (err) {
    if (err instanceof AuthError) {
      stderr.write(
        chalk.red("Not logged in. Run 'kanban auth login' first.\n")
      );
      throw new NotLoggedInError(err.message);
    }
    throw err;
  }

  const agents = Array.isArray(raw)
    ? raw
    : Array.isArray(raw.agents)
      ? raw.agents
      : [];

  const report: AgentsReport = { apiUrl, agents };
  const structured = formatStructured(report, format);
  if (structured) {
    stdout.write(structured);
  } else {
    stdout.write(formatAgentsTable(report) + "\n");
  }
  return report;
}

// runAgentCreate POSTs { nickname, avatar?, role? } to
// /api/v1/auth/agents and binds the returned token to the local
// credential store by default. The backend requires the caller to be
// an admin; 401/403 surface as NotLoggedInError / AuthError so the
// CLI bootstrap can map them to the documented exit codes.
export async function runAgentCreate(
  opts: RunAgentCreateOptions,
  nickname: string
): Promise<AgentCreateResult> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  const trimmedNick = (nickname ?? "").trim();
  if (!trimmedNick) {
    throw new InvalidUsageError(
      "kanban auth agent create requires a non-empty agent nickname"
    );
  }
  const role = opts.role ?? "ADMIN";
  if (role !== "ADMIN" && role !== "MEMBER" && role !== "VIEWER") {
    throw new InvalidUsageError(
      `kanban auth agent create --role must be one of ADMIN, MEMBER, VIEWER (got "${role}")`
    );
  }
  const bindWhenFinished = opts.bindWhenFinished !== false;

  const payload: { nickname: string; avatar?: string; role: string } = {
    nickname: trimmedNick,
    role,
  };
  if (opts.avatar && opts.avatar.trim()) {
    payload.avatar = opts.avatar.trim();
  }

  let agent: AgentRecord;
  let token: string | undefined;
  try {
    const body = await opts.http.apiPost<{ agent?: AgentRecord; token?: string }>(
      "/api/v1/auth/agents",
      payload
    );
    agent = body.agent ?? (body as unknown as AgentRecord);
    token = body.token;
  } catch (err) {
    if (err instanceof AuthError) {
      stderr.write(
        chalk.red(
          "Not allowed. Admin login is required to create an agent. Run 'kanban auth login' first.\n"
        )
      );
      throw new NotLoggedInError(err.message);
    }
    if (err instanceof ApiError && err.status === 403) {
      stderr.write(
        chalk.red(
          "Admin permission required to create an agent. Re-login with an admin account.\n"
        )
      );
      throw err;
    }
    throw err;
  }

  let bound = false;
  if (token) {
    if (bindWhenFinished) {
      bound = writeAgentToken(opts.oauth, opts.apiUrl, token, agent);
    }
  } else {
    stderr.write(
      chalk.yellow(
        "Server response did not include an agent token; nothing was bound.\n"
      )
    );
  }

  const result: AgentCreateResult = {
    apiUrl,
    agent,
    token: token ?? "",
    bound,
  };
  const structured = formatStructured(result, format);
  if (structured) {
    stdout.write(structured);
  } else {
    stdout.write(formatAgentCreateTable(result) + "\n");
  }
  return result;
}

// runAgentBind writes an externally-issued Agent API token to the CLI's
// credential store. The token is validated up-front by issuing a raw
// fetch against GET /api/v1/users/me so the local OAuth credentials
// (if any) cannot shadow the bind target. If the resolved user is not
// of type='AGENT' the CLI refuses to bind so it cannot accidentally
// store a HUMAN (admin or member) token under the "agent" label.
export async function runAgentBind(
  opts: RunAgentBindOptions
): Promise<AgentBindResult> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  let candidate = resolveBindToken(opts);
  if (!candidate) {
    if (opts.prompt) {
      try {
        candidate = (await opts.prompt()).trim();
      } catch (err) {
        // Inquirer throws a UserAbortError-like exit when the user
        // hits Ctrl-C / Esc. Surface it as InvalidUsageError so the
        // CLI bootstrap maps it to exit 1 instead of an unhandled
        // rejection.
        throw new InvalidUsageError(
          `kanban auth agent bind aborted: ${(err as Error).message ?? "no token supplied"}`
        );
      }
    }
    if (!candidate) {
      throw new InvalidUsageError(
        "kanban auth agent bind requires a token; pass --token, set KANBAN_AGENT_TOKEN, or run interactively"
      );
    }
  }

  const agent = await verifyAgentToken(opts.apiUrl, candidate, stderr);
  const bound = writeAgentToken(opts.oauth, opts.apiUrl, candidate, agent);

  const result: AgentBindResult = { apiUrl, agent, bound };
  const structured = formatStructured(result, format);
  if (structured) {
    stdout.write(structured);
  } else {
    stdout.write(formatAgentBindTable(result) + "\n");
  }
  return result;
}

// verifyAgentToken calls GET /api/v1/users/me with the supplied
// bearer token and asserts the resolved user is of type='AGENT'.
// Surfaces a typed InvalidUsageError on 401/404 so callers can
// re-raise without leaking the underlying HTTP detail.
async function verifyAgentToken(
  apiUrl: string,
  token: string,
  stderr: NodeJS.WritableStream
): Promise<AgentRecord> {
  const url = `${stripTrailingSlash(apiUrl)}/api/v1/users/me`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    stderr.write(
      chalk.red(`Network error contacting ${apiUrl}: ${(err as Error).message}\n`)
    );
    throw new InvalidUsageError(
      `kanban auth agent bind: network error: ${(err as Error).message}`
    );
  }
  if (res.status === 401 || res.status === 403) {
    stderr.write(
      chalk.red(
        "Token rejected by server. Run `kanban auth agent create` to mint a fresh one.\n"
      )
    );
    throw new InvalidUsageError("invalid agent token");
  }
  if (res.status === 404) {
    stderr.write(
      chalk.red("Server did not recognise the token endpoint.\n")
    );
    throw new InvalidUsageError("invalid agent token endpoint");
  }
  if (!res.ok) {
    stderr.write(
      chalk.red(`Unexpected status ${res.status} from /api/v1/users/me.\n`)
    );
    throw new InvalidUsageError(`kanban auth agent bind: HTTP ${res.status}`);
  }
  const body = (await res.json().catch(() => ({}))) as {
    user?: { id?: string; type?: string; nickname?: string; username?: string };
  };
  const u = body.user;
  if (!u?.id) {
    stderr.write(
      chalk.red("Server returned no user for the supplied token.\n")
    );
    throw new InvalidUsageError(
      "kanban auth agent bind: server returned no user"
    );
  }
  if (u.type && u.type !== "AGENT") {
    stderr.write(
      chalk.red(
        `Token resolved to a ${u.type} user, not an AGENT. Refusing to bind.\n`
      )
    );
    throw new InvalidUsageError(
      `kanban auth agent bind requires an Agent token (got type=${u.type})`
    );
  }
  return {
    id: u.id,
    nickname: u.nickname,
    username: u.username,
    type: u.type ?? "AGENT",
  };
}

// runAgentDelete DELETEs /api/v1/auth/agents?id=<id>. The endpoint
// requires admin rights; the caller's existing OAuth session is what
// authenticates the request. There is no --yes gate (mirrors archived /
// subtasks delete) so the command is safe to embed in scripts.
export async function runAgentDelete(
  opts: RunAgentDeleteOptions,
  agentId: string
): Promise<AgentDeleteResult> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  const trimmed = (agentId ?? "").trim();
  if (!trimmed) {
    throw new InvalidUsageError(
      "kanban auth agent delete requires an agent id"
    );
  }

  let res: { success?: boolean };
  try {
    res = await opts.http.apiDelete<{ success?: boolean }>(
      "/api/v1/auth/agents",
      undefined,
      { query: { id: trimmed } }
    );
  } catch (err) {
    if (err instanceof AuthError) {
      stderr.write(
        chalk.red("Not logged in. Run 'kanban auth login' first.\n")
      );
      throw new NotLoggedInError(err.message);
    }
    if (err instanceof NotFoundError) {
      stderr.write(chalk.red(`agent not found: ${trimmed}\n`));
    }
    throw err;
  }

  const result: AgentDeleteResult = {
    apiUrl,
    id: trimmed,
    success: res?.success ?? true,
  };
  const structured = formatStructured(result, format);
  if (structured) {
    stdout.write(structured);
  } else {
    stdout.write(
      `${chalk.green("Deleted agent")} ${trimmed}\n`
    );
  }
  return result;
}

// writeAgentToken persists the supplied Agent API token to the
// OAuthClient's SecretProvider. Returns true on success so the
// AgentCreateResult / AgentBindResult callers can surface a
// "bound to local profile" hint. We deliberately do *not* set a
// refresh token or accessExpiresAt: API tokens are long-lived and the
// backend only invalidates them on reset-token / delete, neither of
// which the CLI silently performs.
export function writeAgentToken(
  oauth: OAuthClient,
  apiUrl: string,
  token: string,
  agent: AgentRecord
): boolean {
  const id = (agent.id ?? "").trim() || "agent-unknown";
  const stored: StoredCredentials = {
    apiUrl: stripTrailingSlash(apiUrl),
    clientId: `agent:${id}`,
    clientName: CLIENT_NAME_AGENT,
    accessToken: token,
  };
  oauth.secretProvider.write(stored);
  return true;
}

function resolveBindToken(opts: RunAgentBindOptions): string | null {
  const flag = opts.token?.trim();
  if (flag) return flag;
  const envName = "KANBAN_AGENT_TOKEN";
  const fromEnv = opts.envToken ?? process.env[envName];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return null;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function formatAgentsTable(r: AgentsReport): string {
  const lines: string[] = [];
  lines.push(`${chalk.bold("Agents")}  ${chalk.cyan(r.apiUrl)}`);
  lines.push("");
  if (!r.agents.length) {
    lines.push(chalk.gray("(no agents)"));
    return lines.join("\n");
  }
  const table = new Table({
    head: [
      chalk.bold("ID"),
      chalk.bold("Nickname"),
      chalk.bold("Role"),
      chalk.bold("Enabled"),
      chalk.bold("Last active"),
    ],
    style: { head: [], border: [] },
  });
  for (const a of r.agents) {
    table.push([
      a.id ?? chalk.gray("(unknown)"),
      a.nickname ?? chalk.gray("(unnamed)"),
      a.role ?? chalk.gray("(none)"),
      a.enabled === false ? chalk.red("no") : chalk.green("yes"),
      a.lastActiveAt ?? chalk.gray("never"),
    ]);
  }
  lines.push(table.toString());
  return lines.join("\n");
}

function formatAgentCreateTable(r: AgentCreateResult): string {
  const lines: string[] = [];
  lines.push(`${chalk.bold("Created agent")}  ${chalk.cyan(r.apiUrl)}`);
  lines.push("");
  const table = new Table({
    head: [chalk.bold("Field"), chalk.bold("Value")],
    style: { head: [], border: [] },
  });
  table.push(
    ["ID", r.agent.id ?? chalk.gray("(unknown)")],
    ["Nickname", r.agent.nickname ?? chalk.gray("(unnamed)")],
    ["Type", r.agent.type ?? "AGENT"],
    ["Role", r.agent.role ?? chalk.gray("(none)")],
    ["Token", r.token ? chalk.yellow(r.token) : chalk.gray("(none)")],
    ["Bound", r.bound ? chalk.green("yes") : chalk.red("no")]
  );
  lines.push(table.toString());
  if (r.token) {
    lines.push("");
    lines.push(
      chalk.yellow(
        "Store this token securely — it is the only time the CLI will display it."
      )
    );
  }
  return lines.join("\n");
}

function formatAgentBindTable(r: AgentBindResult): string {
  const lines: string[] = [];
  lines.push(`${chalk.bold("Bound agent token")}  ${chalk.cyan(r.apiUrl)}`);
  lines.push("");
  const table = new Table({
    head: [chalk.bold("Field"), chalk.bold("Value")],
    style: { head: [], border: [] },
  });
  table.push(
    ["ID", r.agent.id ?? chalk.gray("(unknown)")],
    ["Nickname", r.agent.nickname ?? chalk.gray("(unnamed)")],
    ["Type", r.agent.type ?? "AGENT"],
    ["Bound", r.bound ? chalk.green("yes") : chalk.red("no")]
  );
  lines.push(table.toString());
  return lines.join("\n");
}
