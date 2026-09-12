// CLI sub-commands for managing the OAuth-credentialed session of the CLI.
//
// The functions in this module are pure orchestration: they receive an
// already-constructed OAuthClient (and optionally an HttpClient for whoami)
// and a pair of stdio streams for human-readable output. The CLI entry
// script in ../../index.ts wires these up against process.stdout/stderr and
// builds the OAuthClient from KANBAN_API_URL. Tests inject mocks so each
// scenario can be exercised deterministically (happy path, cancel, timeout).

import chalk from "chalk";
import { OAuthClient } from "./client.js";
import type { StoredCredentials } from "./token-store.js";
import { HttpClient, AuthError, NetworkError, ApiError } from "../http/client.js";

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
}

// runLogin drives the OAuth 2.1 device authorization grant end-to-end:
//   1. ensureRegistered (DCR if no clientId on disk) — done by authorizeInteractive
//   2. request a device code (visit URL + user code)
//   3. print the prompt to stderr
//   4. poll the token endpoint until approved / denied / expired
//
// onPrompt is intentionally implicit: the human already saw the prompt in
// the browser, so we just wait. Tests that want to simulate a "deny" can
// subclass / wrap OAuthClient, or pass a custom onPrompt via a future
// options field; for now runLogin hard-codes "approve" because the CLI
// cannot click a browser button on the user's behalf.
export async function runLogin(
  opts: CommandOptions,
  deps: { oauth: OAuthClient; io?: CommandIO }
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
      onPrompt: async (poll) => {
        stderr.write(
          [
            "",
            chalk.bold("Open Kanban authorization required"),
            `  Visit:  ${chalk.cyan(poll.verificationUri)}`,
            `  Code:   ${chalk.cyan(poll.userCode)}`,
            `  Scope:  ${poll.scope}`,
            `  Waiting for approval (expires in ${Math.max(0, Math.round((poll.expiresAt - Date.now()) / 1000))}s)...`,
            "",
          ].join("\n") + "\n"
        );
        return "approve";
      },
    });
    const stored = deps.oauth.loadCredentials();
    stdout.write(
      chalk.green(
        `Logged in to ${apiUrl} as ${stored?.clientId ?? "unknown client"} (scope: ${tok.scope ?? stored?.scope ?? "default"})\n`
      )
    );
    return { credentials: stored };
  } catch (err) {
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
