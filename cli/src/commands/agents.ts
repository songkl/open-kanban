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

import { spawn } from "node:child_process";
import chalk from "chalk";
import Table from "cli-table3";
import {
  HttpClient,
  AuthError,
  NotFoundError,
  ApiError,
  NetworkError,
} from "../http/client.js";
import { InvalidUsageError } from "./boards.js";
import { NotLoggedInError } from "./dashboard.js";
import { formatStructured } from "../output/format.js";
import { OAuthClient } from "../auth/client.js";
import type { StoredCredentials } from "../auth/token-store.js";
import { DeviceFlowError } from "../auth/device-flow.js";

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
  // s-1131: creator identification. Populated by
  // GET /api/v1/auth/agents for Agents created via the API path; legacy
  // AGENT rows (created before the column existed) leave these as
  // undefined so the table renders a "(legacy)" placeholder instead of
  // a misleading empty cell.
  createdBy?: string;
  createdByNickname?: string;
  createdByUsername?: string;
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

// runAgentLogin drives an end-to-end "log in as an Agent" flow: it runs
// the OAuth device authorization grant (same plumbing as `auth login`),
// launches the browser to the verification page so the human approver
// can pick "bind existing Agent" or "create new Agent", then validates
// that the resulting token resolves to a `type='AGENT'` user before
// persisting it under the agent-token marker. The previous credentials
// (human or agent) are preserved on any failure so the operator is
// never stranded mid-migration.
export interface RunAgentLoginOptions {
  apiUrl: string;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
  oauth: OAuthClient;
  // openBrowser (default: true) controls whether the verification URL
  // is launched in the user's default browser via the OS shell. CI /
  // headless setups pass false to suppress the side effect. Failures
  // from the browser-launch helper are logged but never fatal — the
  // operator can still copy the URL manually.
  openBrowser?: boolean;
  // openBrowserImpl is injectable for tests; defaults to a platform-
  // aware openInBrowser helper that calls `open` (macOS),
  // `xdg-open` (Linux), or `cmd /c start` (Windows).
  openBrowserImpl?: (url: string) => void | Promise<void>;
  // authorizeImpl is injectable for tests; defaults to
  // `opts.oauth.authorizeInteractive`. The override lets tests skip
  // the real device flow while still exercising the post-login
  // validation + persistence branches.
  authorizeImpl?: (params: {
    apiUrl: string;
    clientName?: string;
    appName?: string;
    onPrompt?: (poll: {
      verificationUri: string;
      verificationUriComplete?: string;
      userCode: string;
      scope: string;
      expiresAt: number;
    }) => Promise<"approve" | "deny">;
  }) => Promise<{ access_token: string; scope?: string; expires_in: number }>;
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

// runAgentLogin drives the end-to-end "log in as an Agent" flow.
//
//   1. capture the previous credentials (so we can restore on failure)
//   2. run the OAuth 2.1 device authorization grant via
//      OAuthClient.authorizeInteractive. The onPrompt callback prints
//      the verification URL + user code on stderr and, by default,
//      launches the URL in the user's default browser so the human
//      approver can pick "bind existing Agent" or "create new Agent"
//      on the page.
//   3. after approval, call GET /api/v1/users/me with the freshly
//      minted access token to confirm the bound user is type='AGENT'.
//      A HUMAN result means the operator approved as themselves
//      instead of an Agent, so we refuse to bind and restore the
//      previous credentials.
//   4. if type='AGENT', persist the token under the agent-marker
//      format (clientName=kanban-cli/agent-token, clientId=agent:<id>)
//      so subsequent `kanban ...` calls run as the Agent.
//
// The previous credentials are preserved on every failure path
// (network, denial, expiry, HUMAN bound, missing agent_id, ...) so the
// operator is never stranded mid-migration.
export async function runAgentLogin(
  opts: RunAgentLoginOptions
): Promise<AgentBindResult> {
  const stderr = opts.io?.stderr ?? process.stderr;
  const stdout = opts.io?.stdout ?? process.stdout;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  // Snapshot the previous credentials so we can restore on any
  // failure path (denial, HUMAN bound, network, ...). The
  // FileSecretProvider stores ciphertext at rest, so a JSON round-trip
  // through `read()` is safe.
  const credsBefore = opts.oauth.loadCredentials();
  const openBrowser = opts.openBrowser !== false;
  const openImpl = opts.openBrowserImpl ?? openInBrowser;
  const authorize =
    opts.authorizeImpl ??
    ((params: Parameters<NonNullable<RunAgentLoginOptions["authorizeImpl"]>>[0]) =>
      opts.oauth.authorizeInteractive(params) as Promise<{
        access_token: string;
        scope?: string;
        expires_in: number;
      }>);

  let tok: { access_token: string; scope?: string; expires_in: number };
  try {
    tok = await authorize({
      apiUrl,
      clientName: "open-kanban-cli",
      appName: "kanban-cli",
      onPrompt: buildAgentLoginOnPrompt(stderr, openBrowser, openImpl),
    });
  } catch (err) {
    // Map the same denial / expiry / network shapes as runLogin so the
    // top-level CLI exit code matches the documented contract.
    const reason = (err as Error).message ?? String(err);
    if (/denied/i.test(reason)) {
      stderr.write(chalk.red(`Authorization denied: ${reason}\n`));
      throw new InvalidUsageError(`kanban auth agent login denied: ${reason}`);
    }
    if (/expired/i.test(reason)) {
      stderr.write(chalk.red(`Authorization timed out: ${reason}\n`));
      throw new InvalidUsageError(`kanban auth agent login timed out: ${reason}`);
    }
    if (
      err instanceof NetworkError ||
      /network|ENOTFOUND|ECONN|fetch failed/i.test(reason)
    ) {
      stderr.write(chalk.red(`Network error during agent login: ${reason}\n`));
      throw new NetworkError(reason);
    }
    if (err instanceof DeviceFlowError) {
      stderr.write(chalk.red(`OAuth device flow failed: ${reason}\n`));
    } else {
      stderr.write(chalk.red(`Agent login failed: ${reason}\n`));
    }
    throw err;
  }

  // The OAuth client already persisted the token (human-style marker).
  // Read it back so we can validate + rewrite in agent-style format.
  const justPersisted = opts.oauth.loadCredentials();
  const token = tok.access_token ?? justPersisted?.accessToken;
  if (!token) {
    restorePreviousCredentials(opts.oauth, credsBefore);
    throw new InvalidUsageError(
      "kanban auth agent login: OAuth device flow returned no access token"
    );
  }

  let agent: AgentRecord;
  try {
    agent = await verifyAgentToken(opts.apiUrl, token, stderr);
  } catch (err) {
    // verifyAgentToken surfaces InvalidUsageError on 401/404/HUMAN,
    // and a network-shaped InvalidUsageError on fetch failure. In
    // every case the human-side token left over from the device flow
    // is useless for `kanban auth agent ...`, so restore the previous
    // credentials before re-throwing so the operator is never left
    // mid-migration.
    restorePreviousCredentials(opts.oauth, credsBefore);
    throw err;
  }

  const bound = writeAgentToken(opts.oauth, opts.apiUrl, token, agent);

  const result: AgentBindResult = { apiUrl, agent, bound };
  const structured = formatStructured(result, format);
  if (structured) {
    stdout.write(structured);
  } else {
    stdout.write(formatAgentLoginResult(result) + "\n");
  }
  return result;
}

// restorePreviousCredentials is the failure-path backstop for
// runAgentLogin: OAuthClient.authorizeInteractive has already
// overwritten the credential file with the freshly minted (but
// possibly HUMAN-bound) token, so we need to put the operator's
// pre-login state back. A no-op when the operator started fresh.
function restorePreviousCredentials(
  oauth: OAuthClient,
  prev: StoredCredentials | null
): void {
  if (prev) {
    oauth.secretProvider.write(prev);
  } else {
    try {
      oauth.secretProvider.clear();
    } catch {
      // best effort: if clear() fails the operator can recover with
      // `kanban auth logout` once the broken state surfaces.
    }
  }
}

// buildAgentLoginOnPrompt returns the onPrompt handler that prints the
// device-flow verification URL + user code on stderr and (when
// enabled) launches the URL in the default browser. Mirrors the
// shape of runLogin's onPrompt (s-1131 deep-link preference, identity-
// selection hint) so the operator-facing message stays consistent
// between `auth login` and `auth agent login`.
function buildAgentLoginOnPrompt(
  stderr: NodeJS.WritableStream,
  openBrowser: boolean,
  openImpl: (url: string) => void | Promise<void>
) {
  return async (poll: {
    verificationUri: string;
    verificationUriComplete?: string;
    userCode: string;
    scope: string;
    expiresAt: number;
  }): Promise<"approve"> => {
    const expiresIn = Math.max(
      0,
      Math.round((poll.expiresAt - Date.now()) / 1000)
    );
    const visitLine = poll.verificationUriComplete
      ? `  Visit:  ${chalk.cyan(poll.verificationUriComplete)}`
      : `  Visit:  ${chalk.cyan(poll.verificationUri)}  (code ${poll.userCode})`;
    const lines: string[] = [
      "",
      chalk.bold("Open Kanban agent authorization required"),
      visitLine,
      poll.verificationUriComplete
        ? `  Or enter code ${chalk.cyan(poll.userCode)} at ${chalk.cyan(poll.verificationUri)}`
        : "",
      `  Scope:  ${poll.scope}`,
      "",
      chalk.yellow(
        "  On the approval page, pick \"Bind existing agent\" or \"Create new agent\" so the device flow resolves to an Agent identity (not your personal account)."
      ),
      "",
      `  Waiting for approval (expires in ${expiresIn}s)...`,
      "",
    ].filter((line) => line !== "");
    stderr.write(lines.join("\n") + "\n");
    if (openBrowser) {
      const url = poll.verificationUriComplete ?? poll.verificationUri;
      try {
        await openImpl(url);
      } catch (err) {
        // Browser launch is best-effort: an unattended CI runner
        // without $DISPLAY will throw ENOENT / EACCES, but the
        // operator can still copy the URL printed above.
        stderr.write(
          chalk.yellow(
            `  (could not launch browser: ${(err as Error).message ?? String(err)})\n`
          )
        );
      }
    }
    return "approve";
  };
}

// openInBrowser launches `url` in the user's default browser. The
// command is forked-and-forgotten (detached + stdio piped) so a slow
// browser launch never blocks the OAuth polling loop. Exported so
// tests can spy on the platform-aware dispatch.
export function openInBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {
      // Swallow ENOENT/ENOEXEC etc. The onPrompt handler logs a
      // user-visible hint and falls back to the printed URL.
    });
    child.unref?.();
  } catch {
    // Spawn is synchronous-but-throws only for argument validation
    // errors we already guard against; nothing else to do here.
  }
}

function formatAgentLoginResult(r: AgentBindResult): string {
  const lines: string[] = [];
  lines.push(`${chalk.bold("Bound agent via device flow")}  ${chalk.cyan(r.apiUrl)}`);
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
  // Detect whether any row carries creator info; if none do (e.g.
  // an older server that hasn't shipped the column yet), drop the
  // "Created by" column rather than render a wall of "(legacy)"
  // placeholders.
  const anyCreator = r.agents.some((a) => Boolean(a.createdBy));
  const head: string[] = [
    chalk.bold("ID"),
    chalk.bold("Nickname"),
    chalk.bold("Role"),
    chalk.bold("Enabled"),
    chalk.bold("Last active"),
  ];
  if (anyCreator) head.push(chalk.bold("Created by"));
  const table = new Table({
    head,
    style: { head: [], border: [] },
  });
  for (const a of r.agents) {
    const row: (string | ReturnType<typeof chalk.red>)[] = [
      a.id ?? chalk.gray("(unknown)"),
      a.nickname ?? chalk.gray("(unnamed)"),
      a.role ?? chalk.gray("(none)"),
      a.enabled === false ? chalk.red("no") : chalk.green("yes"),
      a.lastActiveAt ?? chalk.gray("never"),
    ];
    if (anyCreator) {
      // Legacy AGENT rows (pre-s-1131) have no creator recorded;
      // surface that explicitly so operators can audit / backfill.
      const creator = a.createdByNickname || a.createdByUsername || a.createdBy;
      row.push(creator ? chalk.cyan(creator) : chalk.gray("(legacy)"));
    }
    table.push(row);
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
    // s-1131: surface the creator so the operator can audit the
    // new Agent row without flipping back to the web UI.
    ["Created by", r.agent.createdBy ?? chalk.gray("(unknown)")],
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
