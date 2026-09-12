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

program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
