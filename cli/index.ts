// CLI entry point. Resolves runtime options from env vars / flags, builds
// the OAuth + Http collaborators, hands them to `createProgram` (which
// wires the full command tree in cli/src/program.ts), and parses argv.

import { Command } from "commander";
import { buildOAuthClient, createProgram } from "./src/program.js";
import { HttpClient } from "./src/http/client.js";

// extractEarlyFlags scans argv for `--api-url` and `--profile` *before*
// Commander sees them. Without this, the shared OAuth + Http clients
// would always be constructed against the env-var defaults — even when
// the user explicitly passed `--api-url` at the command line — because
// action handlers consume `program.opts()` *after* parsing, but the
// shared clients are wired at boot.
function extractEarlyFlags(
  argv: string[]
): { apiUrl?: string; profile?: string } {
  const out: { apiUrl?: string; profile?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--api-url") {
      const v = argv[i + 1];
      if (v && !v.startsWith("--")) {
        out.apiUrl = v;
        i++;
      }
    } else if (a.startsWith("--api-url=")) {
      out.apiUrl = a.slice("--api-url=".length);
    } else if (a === "--profile") {
      const v = argv[i + 1];
      if (v && !v.startsWith("--")) {
        out.profile = v;
        i++;
      }
    } else if (a.startsWith("--profile=")) {
      out.profile = a.slice("--profile=".length);
    }
  }
  return out;
}

const early = extractEarlyFlags(process.argv);
const apiUrl = early.apiUrl ?? process.env.KANBAN_API_URL ?? "http://localhost:8080";
const profile = early.profile ?? process.env.KANBAN_CLI_PROFILE;

const oauth = buildOAuthClient(apiUrl, profile);
const http = new HttpClient({ apiUrl, profile });
http.attachOAuth(oauth);

const program = createProgram({ apiUrl, profile }, { oauth, http });

// Re-export for the test harness; otherwise unused at runtime.
export { Command };
program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});