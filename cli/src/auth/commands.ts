// CLI sub-commands for managing the OAuth-credentialed session of the CLI.
//
// The functions in this module are pure orchestration: they receive an
// already-constructed OAuthClient (and optionally an HttpClient for whoami)
// and a pair of stdio streams for human-readable output. The CLI entry
// script in ../../index.ts wires these up against process.stdout/stderr and
// builds the OAuthClient from KANBAN_API_URL. Tests inject mocks so each
// scenario can be exercised deterministically (happy path, cancel, timeout).

import { spawn } from "node:child_process";
import chalk from "chalk";
import { OAuthClient } from "./client.js";
import type { StoredCredentials } from "./token-store.js";
import { HttpClient, AuthError, NetworkError, ApiError } from "../http/client.js";
import { DeviceFlowError } from "./device-flow.js";

export interface CommandIO {
  // stdout/stderr are the streams the command writes to. Defaults to the
  // process streams when the CLI entry runs; tests pass capture streams.
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface CommandOptions {
  // apiUrl is what the OAuth server's discovery document lives at. Used for
  // status output and to build the OAuthClient when one is not injected.
  apiUrl: string;
  // profile is the basename (KANBAN_CLI_PROFILE) under ~/.config/kanban-cli/.
  // Status displays it so users can tell which account is active.
  profile?: string;
  // timeoutSeconds bounds the device flow polling loop. The default matches
  // the device_code.expires_in cap most OAuth servers issue (10 minutes).
  timeoutSeconds?: number;
}

// LoginMode selects which identity `kanban auth login` binds the
// freshly minted OAuth token to. The default is 'agent' because the
// CLI is almost always wired to an unattended runner / automation
// process; binding to the human approver's account by default leaks
// the admin identity into long-running daemons (s-1231). Operators
// who genuinely need a human-bound session opt in with `--as-human`
// (or by calling `kanban auth agent login` for the agent path).
export type LoginMode = "human" | "agent";

export interface RunLoginOptions extends CommandOptions {
  // mode defaults to 'agent' (s-1231). Pass 'human' to restore the
  // legacy behaviour where the device flow binds the token to the
  // human approver's account.
  mode?: LoginMode;
  // openBrowser (default: true) controls whether the verification URL
  // is launched in the user's default browser. Honoured only when
  // mode === 'agent'; the legacy human flow never launches the browser
  // because the operator is expected to copy / paste the URL.
  openBrowser?: boolean;
  // openBrowserImpl is injectable for tests; defaults to a platform-
  // aware openInBrowser helper that calls `open` (macOS), `xdg-open`
  // (Linux), or `cmd /c start` (Windows).
  openBrowserImpl?: (url: string) => void | Promise<void>;
}

export interface RunLoginDeps {
  oauth: OAuthClient;
  // http is required when mode === 'agent' (the runner needs to call
  // GET /api/v1/users/me to confirm the bound user is type='AGENT').
  // Optional when mode === 'human' for backward compatibility with
  // tests that only exercise the legacy path.
  http?: HttpClient;
  io?: CommandIO;
  // openBrowserImpl is injectable for tests; defaults to a platform-
  // aware openInBrowser helper that calls `open` (macOS),
  // `xdg-open` (Linux), or `cmd /c start` (Windows). Honoured only
  // when mode === 'agent'. Accepted in deps so tests can stub it
  // without enlarging RunLoginOptions' public shape.
  openBrowserImpl?: (url: string) => void | Promise<void>;
}

// authExitCodeForError maps the exceptions thrown by these commands to
// POSIX-style exit codes documented in CLI_PROJECT_PLAN §6.
//
//   2  not logged in             — runLoginBeforeYouCall / runWhoami w/o creds
//   3  user denied authorization  — device flow access_denied / onPrompt deny
//   6  network error              — discovery / DCR / token endpoint failures
//
// Anything else surfaces as exit code 1 so misbehaving scripts get a clear
// signal that an unexpected condition occurred.
export function authExitCodeForError(err: unknown): number {
  if (err instanceof AuthError) return 2;
  if (err instanceof NetworkError) return 6;
  if (err instanceof DeniedAuthorizationError) return 3;
  if (err instanceof NotLoggedInError) return 2;
  if (err instanceof ApiError) return 1;
  if (err instanceof Error && /denied/i.test(err.message)) return 3;
  if (err instanceof Error && /network|ENOTFOUND|ECONN|fetch failed/i.test(err.message)) return 6;
  return 1;
}

// NotLoggedInError is thrown when status/logout/whoami run without stored
// credentials. It is distinct from the AuthError raised by the HttpClient
// (which is the HTTP layer saying "this request failed with 401") so the
// CLI can produce a "Run 'kanban auth login' first" hint instead of an
// opaque auth failure message.
export class NotLoggedInError extends Error {
  constructor(message = "not logged in") {
    super(message);
    this.name = "NotLoggedInError";
  }
}

// DeniedAuthorizationError is thrown when the user rejects the device flow
// prompt or the OAuth server returns access_denied / expired_token during
// polling. The CLI surfaces the underlying detail on stderr and exits 3.
export class DeniedAuthorizationError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = "DeniedAuthorizationError";
  }
}

export interface RunLoginResult {
  // credentials is whatever authorizeInteractive ultimately persisted via
  // the secretProvider. Returned so tests can assert on it without
  // re-reading the provider.
  credentials: StoredCredentials | null;
  // agent is set when mode === 'agent' and the device flow resolved to
  // a type='AGENT' user. Callers that need to surface the bound Agent's
  // id / nickname can read this; the legacy 'human' path leaves it
  // undefined so existing tests don't need to widen their assertions.
  agent?: {
    id?: string;
    nickname?: string;
    username?: string;
    type?: string;
  };
}

// runLogin drives the OAuth 2.1 device authorization grant end-to-end:
//   1. ensureRegistered (DCR if no clientId on disk) — done by authorizeInteractive
//   2. request a device code (visit URL + user code)
//   3. print the prompt to stderr
//   4. poll the token endpoint until approved / denied / expired
//
// s-1231: the CLI defaults to agent-bound login because the runner /
// automation use case is the dominant one. Operators who need the
// legacy human-binding behaviour (e.g. an interactive admin who
// wants to drive the dashboard from the terminal) opt in with
// `--as-human` / `mode: 'human'`. When the default (agent) flow
// resolves to a HUMAN user — usually because the operator approved
// the picker as their personal account — the function refuses to
// persist the credential and rolls back to the previous state, the
// same behaviour `kanban auth agent login` already implements.
//
// onPrompt is intentionally implicit: the human already saw the prompt
// in the browser, so we just wait. Tests that want to simulate a
// "deny" can subclass / wrap OAuthClient, or pass a custom onPrompt
// via a future options field; for now runLogin hard-codes "approve"
// because the CLI cannot click a browser button on the user's behalf.
//
// s-1131: the prompt also surfaces the deep-link URL (with the
// user_code pre-filled via `?code=...`) and an explicit hint that
// CLI / MCP clients must pick an identity (Human vs Agent) on the
// approval page. Without the hint, unattended operators can miss
// the picker and accidentally approve as their personal account.
export async function runLogin(
  opts: RunLoginOptions,
  deps: RunLoginDeps
): Promise<RunLoginResult> {
  const mode: LoginMode = opts.mode ?? "agent";
  if (mode === "agent") {
    return runLoginAsAgent(opts, deps);
  }
  return runLoginAsHuman(opts, deps);
}

// runLoginAsHuman keeps the original OAuth-only flow: the device-flow
// token is persisted under the human-marker (clientName=open-kanban-cli)
// and the credential store is rewritten in place. Callers reach this
// branch via `kanban auth login --as-human`.
async function runLoginAsHuman(
  opts: RunLoginOptions,
  deps: RunLoginDeps
): Promise<RunLoginResult> {
  const stderr = deps.io?.stderr ?? process.stderr;
  const stdout = deps.io?.stdout ?? process.stdout;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const credsBefore = deps.oauth.loadCredentials();
  const clientName = credsBefore?.clientName ?? "open-kanban-cli";
  const appName = "kanban-cli";
  try {
    const tok = await deps.oauth.authorizeInteractive({
      apiUrl,
      clientName,
      appName,
      onPrompt: buildOnPrompt(stderr, clientName),
    });
    const stored = deps.oauth.loadCredentials();
    stdout.write(
      chalk.green(
        `Logged in to ${apiUrl} as ${stored?.clientId ?? "unknown client"} (scope: ${tok.scope ?? stored?.scope ?? "default"})\n`
      )
    );
    return { credentials: stored };
  } catch (err) {
    // s-1133: when the OAuth server rejects the cached client_id
    // (e.g. the operator wiped oauth_clients between sessions, or
    // restored a backup that pre-dates this registration) the device
    // authorization endpoint returns `invalid_client` / "unknown
    // client_id". The cached credentials are now useless, so clear
    // them and retry the device flow once with a freshly registered
    // client. We only retry this specific class of failure — anything
    // else is surfaced verbatim.
    if (isUnknownClientIdError(err)) {
      const oldClientId = deps.oauth.loadCredentials()?.clientId;
      try {
        deps.oauth.secretProvider.clear();
      } catch {
        // best-effort: even if the clear fails the retry will
        // overwrite the file via ensureRegistered.
      }
      stderr.write(
        chalk.yellow(
          `Stored client id ${oldClientId ? `(${oldClientId}) ` : ""}was rejected by the server (unknown client_id); re-registering and retrying once.\n`
        )
      );
      try {
        const tok = await deps.oauth.authorizeInteractive({
          apiUrl,
          clientName,
          appName,
          onPrompt: buildOnPrompt(stderr, clientName),
        });
        const stored = deps.oauth.loadCredentials();
        stdout.write(
          chalk.green(
            `Logged in to ${apiUrl} as ${stored?.clientId ?? "unknown client"} (scope: ${tok.scope ?? stored?.scope ?? "default"})\n`
          )
        );
        return { credentials: stored };
      } catch (retryErr) {
        const retryReason = (retryErr as Error).message ?? String(retryErr);
        stderr.write(chalk.red(`Login failed: ${retryReason}\n`));
        throw retryErr;
      }
    }
    const reason = (err as Error).message ?? String(err);
    if (/denied/i.test(reason)) {
      stderr.write(chalk.red(`Authorization denied: ${reason}\n`));
      throw new DeniedAuthorizationError(reason);
    }
    if (/expired/i.test(reason)) {
      stderr.write(chalk.red(`Authorization timed out: ${reason}\n`));
      throw new DeniedAuthorizationError(reason, "expired_token");
    }
    if (isNetworkError(err)) {
      stderr.write(chalk.red(`Network error during login: ${reason}\n`));
      throw new NetworkError(reason);
    }
    stderr.write(chalk.red(`Login failed: ${reason}\n`));
    throw err;
  }
}

// runLoginAsAgent is the new default `kanban auth login` flow (s-1231):
// it drives the same OAuth device authorization grant, but on success
// it validates that the resolved user is type='AGENT' and rewrites
// the credential store under the agent-token marker (so subsequent
// commands run as the Agent, not the human approver). If the
// approver picked "Myself" by accident and the server returned a
// HUMAN user, runLoginAsAgent refuses to overwrite the credentials
// and rolls back to whatever was on disk before.
//
// The recovery branches mirror runAgentLogin (commands/agents.ts):
// the previous credentials are snapshot up-front, restored on every
// failure path, and the freshly issued token is rewritten under
// `clientName=kanban-cli/agent-token`, `clientId=agent:<id>`.
async function runLoginAsAgent(
  opts: RunLoginOptions,
  deps: RunLoginDeps
): Promise<RunLoginResult> {
  const stderr = deps.io?.stderr ?? process.stderr;
  if (!deps.http) {
    throw new Error(
      "kanban auth login (agent mode) requires the HTTP client; pass deps.http"
    );
  }
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const credsBefore = deps.oauth.loadCredentials();
  const openBrowser = opts.openBrowser !== false;
  const openImpl = deps.openBrowserImpl ?? openInBrowser;

  let tok: { access_token: string; scope?: string; expires_in: number };
  try {
    tok = await deps.oauth.authorizeInteractive({
      apiUrl,
      clientName: "open-kanban-cli",
      appName: "kanban-cli",
      onPrompt: buildAgentOnPrompt(stderr, openBrowser, openImpl),
    });
  } catch (err) {
    // Map the same denial / expiry / network shapes as runLoginAsHuman
    // so the top-level CLI exit code matches the documented contract.
    const reason = (err as Error).message ?? String(err);
    if (/denied/i.test(reason)) {
      stderr.write(chalk.red(`Authorization denied: ${reason}\n`));
      throw new DeniedAuthorizationError(reason);
    }
    if (/expired/i.test(reason)) {
      stderr.write(chalk.red(`Authorization timed out: ${reason}\n`));
      throw new DeniedAuthorizationError(reason, "expired_token");
    }
    if (isNetworkError(err)) {
      stderr.write(chalk.red(`Network error during login: ${reason}\n`));
      throw new NetworkError(reason);
    }
    if (err instanceof DeviceFlowError) {
      stderr.write(chalk.red(`OAuth device flow failed: ${reason}\n`));
    } else {
      stderr.write(chalk.red(`Login failed: ${reason}\n`));
    }
    throw err;
  }

  const justPersisted = deps.oauth.loadCredentials();
  const token = tok.access_token ?? justPersisted?.accessToken;
  if (!token) {
    restorePreviousCredentials(deps.oauth, credsBefore);
    throw new Error("kanban auth login: OAuth device flow returned no access token");
  }

  let agent: { id?: string; nickname?: string; username?: string; type?: string };
  try {
    agent = await verifyAgentToken(apiUrl, token, stderr);
  } catch (err) {
    restorePreviousCredentials(deps.oauth, credsBefore);
    throw err;
  }

  // Persist under the agent-marker format so subsequent `kanban ...`
  // calls dispatch as the Agent. Bound tokens are long-lived so we
  // deliberately omit refreshToken / accessExpiresAt.
  const stored: StoredCredentials = {
    apiUrl,
    clientId: `agent:${(agent.id ?? "").trim() || "agent-unknown"}`,
    clientName: CLIENT_NAME_AGENT,
    accessToken: token,
  };
  deps.oauth.secretProvider.write(stored);
  stderr.write(
    chalk.green(
      `Logged in to ${apiUrl} as Agent ${agent.nickname ?? agent.id ?? "unknown"} (type=${agent.type ?? "AGENT"})\n`
    )
  );
  return { credentials: stored, agent };
}

// CLIENT_NAME_AGENT marks credential-store entries written by the
// agent-login path. Kept here (in addition to commands/agents.ts)
// because the export is used by `kanban auth status` to render an
// "Identity: Agent" hint — both modules need the same constant.
export const CLIENT_NAME_AGENT = "kanban-cli/agent-token";

// restorePreviousCredentials rolls back the credential store to the
// pre-login snapshot. Used by the agent-login failure paths so a
// HUMAN-bound device flow (the operator picked "Myself" on the
// approval page) never silently downgrades the existing session.
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

// verifyAgentToken calls GET /api/v1/users/me with the supplied
// bearer token and asserts the resolved user is of type='AGENT'. The
// agent-login paths in both `runLogin` (default mode, s-1231) and
// `runAgentLogin` (`kanban auth agent login`) share this helper so
// the validation contract stays identical.
async function verifyAgentToken(
  apiUrl: string,
  token: string,
  stderr: NodeJS.WritableStream
): Promise<{ id?: string; nickname?: string; username?: string; type?: string }> {
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
    const reason = (err as Error).message ?? String(err);
    stderr.write(
      chalk.red(`Network error contacting ${apiUrl}: ${reason}\n`)
    );
    throw new Error(`kanban auth login: network error: ${reason}`);
  }
  if (res.status === 401 || res.status === 403) {
    stderr.write(
      chalk.red("Token rejected by server. Re-run `kanban auth login`.\n")
    );
    throw new Error("invalid agent token");
  }
  if (res.status === 404) {
    stderr.write(
      chalk.red("Server did not recognise the token endpoint.\n")
    );
    throw new Error("invalid agent token endpoint");
  }
  if (!res.ok) {
    stderr.write(
      chalk.red(`Unexpected status ${res.status} from /api/v1/users/me.\n`)
    );
    throw new Error(`kanban auth login: HTTP ${res.status}`);
  }
  const body = (await res.json().catch(() => ({}))) as {
    user?: { id?: string; type?: string; nickname?: string; username?: string };
  };
  const u = body.user;
  if (!u?.id) {
    stderr.write(
      chalk.red("Server returned no user for the supplied token.\n")
    );
    throw new Error("kanban auth login: server returned no user");
  }
  if (u.type && u.type !== "AGENT") {
    stderr.write(
      chalk.red(
        `Token resolved to a ${u.type} user, not an AGENT. Refusing to bind — re-run and pick \"Bind existing agent\" or \"Create new agent\" on the approval page.\n`
      )
    );
    throw new Error(
      `kanban auth login requires an Agent token (got type=${u.type})`
    );
  }
  return {
    id: u.id,
    nickname: u.nickname,
    username: u.username,
    type: u.type ?? "AGENT",
  };
}

// buildAgentOnPrompt is the onPrompt handler used by the default
// agent-login path. It prints the deep-link verification URL, the
// scope, the agent-binding hint, and (optionally) launches the
// browser. Mirrors the shape of runAgentLogin's onPrompt so the
// operator-facing message stays consistent between `auth login` and
// `auth agent login`.
function buildAgentOnPrompt(
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
// browser launch never blocks the OAuth polling loop. Mirrors the
// helper in commands/agents.ts so the agent-login UX is identical
// whether the operator typed `auth login` or `auth agent login`.
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

// isUnknownClientIdError returns true when the device authorization or
// token endpoint rejected our cached client_id. The server surfaces
// this as `invalid_client` (RFC 6749 §5.2) with the human-readable
// description `unknown client_id`; we match both the error code and
// the description so this works regardless of which endpoint in the
// device flow surfaced the rejection.
//
// Exported so tests can drive the recovery branch without scraping
// error message strings.
export function isUnknownClientIdError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof DeviceFlowError) {
    if (err.code === "invalid_client") return true;
    return /unknown client_id|invalid client/i.test(err.message);
  }
  const msg = (err as Error).message ?? "";
  return /unknown client_id|invalid_client.*client_id/i.test(msg);
}

// buildOnPrompt returns the onPrompt handler passed to authorizeInteractive.
// It prints the verification URL (preferring the deep-link variant with the
// user_code pre-filled), the scope, an optional CLI/Agent identity-selection
// hint, and the device-code expiry countdown. The handler always returns
// "approve" because the CLI cannot click a browser button on the user's
// behalf; the human has already seen the prompt in the browser.
function buildOnPrompt(stderr: NodeJS.WritableStream, clientName: string) {
  return async (poll: {
    verificationUri: string;
    verificationUriComplete?: string;
    userCode: string;
    scope: string;
    expiresAt: number;
  }): Promise<"approve"> => {
    const expiresIn = Math.max(0, Math.round((poll.expiresAt - Date.now()) / 1000));
    // Prefer the deep link that already encodes the user_code
    // (verification_uri_complete) so users can paste / click it
    // into their browser without retyping the code. Falls back
    // to the plain URL + manual-code path if the server didn't
    // supply one — keeps the CLI working against older servers
    // that only emit the bare verification URI.
    const visitLine = poll.verificationUriComplete
      ? `  Visit:  ${chalk.cyan(poll.verificationUriComplete)}`
      : `  Visit:  ${chalk.cyan(poll.verificationUri)}  (code ${poll.userCode})`;
    const isCliClient = isCliLikeClientName(clientName);
    const lines: (string | null)[] = [
      "",
      chalk.bold("Open Kanban authorization required"),
      visitLine,
      poll.verificationUriComplete
        ? `  Or enter code ${chalk.cyan(poll.userCode)} at ${chalk.cyan(poll.verificationUri)}`
        : null,
      `  Scope:  ${poll.scope}`,
    ];
    if (isCliClient) {
      // The server's CLI-detection heuristic flags our client
      // registration as a CLI / MCP consumer; the approval page
      // will render the identity picker, so warn the operator
      // up-front. Without this hint, unattended operators often
      // miss the picker and accidentally approve as their
      // personal account.
      lines.push(
        "",
        chalk.yellow(
          "  Identity selection: this client looks like a CLI runner. The approval page will ask you to authorise as either your account or an Agent — pick the Agent if this CLI is for unattended automation."
        )
      );
    }
    lines.push("", `  Waiting for approval (expires in ${expiresIn}s)...`, "");
    stderr.write(lines.filter((l): l is string => l !== null).join("\n") + "\n");
    return "approve";
  };
}

// isCliLikeClientName mirrors the server's CLI-detection heuristic
// (oauth.IsAgentIdSelectionRequired in backend/internal/oauth/device.go)
// so the login prompt can warn the operator before the approval
// page renders the identity picker. Mirrored on purpose: the CLI
// has no way to query the server for the heuristic value until
// after the device code has been issued, and we want the warning
// to surface inline with the prompt. The pattern is intentionally
// a subset (only the explicit names + the suffix) so false
// positives don't add noise to a prompt that doesn't need it.
function isCliLikeClientName(name: string | undefined): boolean {
  if (!name) return false;
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return false;
  return (
    trimmed === "kanban-cli" ||
    trimmed === "open-kanban-cli" ||
    trimmed.endsWith("-cli")
  );
}

// runStatus prints a one-screen summary of the active credential: profile,
// host, scope, and access-token remaining lifetime. Exits 2 (via
// NotLoggedInError) when no credentials exist; the CLI entry catches it and
// converts it to the documented exit code.
export interface StatusReport {
  profile: string | undefined;
  apiUrl: string;
  clientId: string;
  clientName: string | undefined;
  scope: string | undefined;
  accessTokenExpiresAt: number | undefined;
  accessTokenRemainingSeconds: number | undefined;
  hasRefreshToken: boolean;
  // isAgentToken is true when the credential store holds an Agent API
  // token written by `kanban auth agent create / bind`. Surfaced so the
  // renderer can swap "Refresh: yes/no" for "Identity: Agent/Human".
  isAgentToken: boolean;
}

export async function runStatus(
  opts: CommandOptions,
  deps: { oauth: OAuthClient; io?: CommandIO }
): Promise<StatusReport> {
  const stderr = deps.io?.stderr ?? process.stderr;
  const stdout = deps.io?.stdout ?? process.stdout;
  const stored = deps.oauth.loadCredentials();
  if (!stored) {
    stderr.write(chalk.red("Not logged in. Run 'kanban auth login' first.\n"));
    throw new NotLoggedInError();
  }
  const report: StatusReport = {
    profile: opts.profile,
    apiUrl: stored.apiUrl,
    clientId: stored.clientId,
    clientName: stored.clientName,
    scope: stored.scope,
    accessTokenExpiresAt: stored.accessExpiresAt,
    accessTokenRemainingSeconds:
      stored.accessExpiresAt !== undefined
        ? Math.max(0, Math.round((stored.accessExpiresAt - Date.now()) / 1000))
        : undefined,
    hasRefreshToken: !!stored.refreshToken,
    isAgentToken: stored.clientName === "kanban-cli/agent-token",
  };
  stdout.write(formatStatus(report) + "\n");
  return report;
}

function formatStatus(r: StatusReport): string {
  const expires =
    r.accessTokenExpiresAt === undefined
      ? chalk.gray("unknown")
      : r.accessTokenRemainingSeconds! <= 0
        ? chalk.yellow("expired (will refresh on next request)")
        : chalk.green(`${formatDuration(r.accessTokenRemainingSeconds!)} remaining`);
  const scope = r.scope ? r.scope : chalk.gray("(none)");
  const profile = r.profile ?? chalk.gray("(default)");
  const identity = r.isAgentToken
    ? chalk.green("Agent (long-lived token)")
    : r.hasRefreshToken
      ? chalk.blue("Human (OAuth device flow)")
      : chalk.yellow("Human (OAuth — no refresh)");
  const refreshLine = r.isAgentToken
    ? `${chalk.bold("Refresh")}:    ${chalk.gray("n/a — long-lived API token")}`
    : `${chalk.bold("Refresh")}:    ${r.hasRefreshToken ? chalk.green("yes") : chalk.red("no")}`;
  return [
    `${chalk.bold("Profile")}:    ${profile}`,
    `${chalk.bold("Host")}:       ${r.apiUrl}`,
    `${chalk.bold("Client ID")}:  ${r.clientId}`,
    `${chalk.bold("Client")}:     ${r.clientName ?? chalk.gray("(unnamed)")}`,
    `${chalk.bold("Scope")}:      ${scope}`,
    `${chalk.bold("Access")}:     ${expires}`,
    refreshLine,
    `${chalk.bold("Identity")}:   ${identity}`,
  ].join("\n");
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// runLogout deletes the credential file via secretProvider.clear() and
// prints a confirmation. Idempotent: clearing an already-empty store is a
// no-op rather than an error, so users can re-run it from a script.
export async function runLogout(
  opts: CommandOptions,
  deps: { oauth: OAuthClient; io?: CommandIO }
): Promise<{ removed: boolean }> {
  const stderr = deps.io?.stderr ?? process.stderr;
  const stdout = deps.io?.stdout ?? process.stdout;
  const had = !!deps.oauth.loadCredentials();
  try {
    deps.oauth.secretProvider.clear();
  } catch (err) {
    const reason = (err as Error).message ?? String(err);
    if (isNetworkError(err)) {
      throw new NetworkError(reason);
    }
    stderr.write(chalk.red(`Logout failed: ${reason}\n`));
    throw err;
  }
  if (had) {
    stdout.write(chalk.green(`Logged out from ${stripTrailingSlash(opts.apiUrl)}.\n`));
  } else {
    stdout.write(chalk.gray("No credentials found; nothing to do.\n"));
  }
  return { removed: had };
}

// WhoamiResponse matches the JSON shape returned by GET /api/v1/users/me on
// the kanban server. We only consume the fields we display; the rest
// pass through as `unknown` in case future versions add metadata the CLI
// wants to surface (last_active_at, board count, etc.).
export interface WhoamiUser {
  id?: string;
  username?: string;
  nickname?: string;
  type?: string;
  role?: string;
  avatar?: string;
}

export interface WhoamiResponse {
  user?: WhoamiUser | null;
  permissions?: unknown;
  needsSetup?: boolean;
}

export interface WhoamiReport {
  apiUrl: string;
  user: WhoamiUser;
  raw: WhoamiResponse;
}

// runWhoami calls GET /api/v1/users/me to display the currently
// authenticated user. The endpoint path is configurable (some deployments
// route /me under /api/auth/me) so tests can pass a custom path via
// deps.http; production callers should rely on the default.
//
// Errors are re-mapped to the documented CLI exit codes:
//   - missing credentials  → NotLoggedInError → exit 2
//   - 401                  → AuthError        → exit 2
//   - network failures     → NetworkError     → exit 6
export async function runWhoami(
  opts: CommandOptions,
  deps: { oauth: OAuthClient; http: HttpClient; path?: string; io?: CommandIO }
): Promise<WhoamiReport> {
  const stderr = deps.io?.stderr ?? process.stderr;
  const stdout = deps.io?.stdout ?? process.stdout;
  const stored = deps.oauth.loadCredentials();
  if (!stored?.accessToken && !stored?.refreshToken) {
    stderr.write(chalk.red("Not logged in. Run 'kanban auth login' first.\n"));
    throw new NotLoggedInError();
  }
  deps.http.attachOAuth(deps.oauth);
  const path = deps.path ?? "/api/v1/users/me";
  let body: WhoamiResponse;
  try {
    body = await deps.http.apiGet<WhoamiResponse>(path);
  } catch (err) {
    if (err instanceof AuthError) {
      stderr.write(chalk.red("Session expired. Run 'kanban auth login' again.\n"));
      throw new NotLoggedInError(err.message);
    }
    if (err instanceof NetworkError) {
      stderr.write(chalk.red(`Network error contacting ${opts.apiUrl}: ${err.message}\n`));
      throw err;
    }
    throw err;
  }
  if (!body.user || (body.needsSetup && !body.user.id)) {
    stderr.write(chalk.yellow("Server reports the workspace is not initialised yet.\n"));
    throw new NotLoggedInError("server returned no user");
  }
  const report: WhoamiReport = {
    apiUrl: stripTrailingSlash(opts.apiUrl),
    user: body.user,
    raw: body,
  };
  stdout.write(formatWhoami(report) + "\n");
  return report;
}

function formatWhoami(r: WhoamiReport): string {
  const u = r.user;
  const lines = [
    `${chalk.bold("Host")}:    ${r.apiUrl}`,
    `${chalk.bold("ID")}:      ${u.id ?? chalk.gray("(unknown)")}`,
    `${chalk.bold("Name")}:    ${u.nickname ?? u.username ?? chalk.gray("(unnamed)")}`,
    `${chalk.bold("User")}:    ${u.username ?? chalk.gray("(none)")}`,
  ];
  if (u.type) lines.push(`${chalk.bold("Type")}:    ${u.type}`);
  if (u.role) lines.push(`${chalk.bold("Role")}:    ${u.role}`);
  if (u.avatar) lines.push(`${chalk.bold("Avatar")}:  ${u.avatar}`);
  return lines.join("\n");
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function isNetworkError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof NetworkError) return true;
  const msg = (err as Error).message ?? "";
  return /network|ENOTFOUND|ECONN|fetch failed|ETIMEDOUT|socket hang up/i.test(msg);
}
