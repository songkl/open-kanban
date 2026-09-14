// CLI entry point. Resolves runtime options from the priority chain
// (CLI flag > env var > config file > built-in default), builds the
// OAuth + Http collaborators, hands them to `createProgram` (which
// wires the full command tree in cli/src/program.ts), and parses argv.

import { Command } from "commander";
import { buildOAuthClient, createProgram } from "./src/program.js";
import { HttpClient } from "./src/http/client.js";
import { resolveRootConfig } from "./src/config.js";

// extractEarlyFlags scans argv for the global flags Commander consumes at
// root level (`--api-url`, `--profile`) *before* Commander sees them.
// Without this, the shared OAuth + Http clients would always be
// constructed against the env-var defaults — even when the user
// explicitly passed `--api-url` on the command line — because action
// handlers read `program.opts()` after parsing, but the shared clients
// are wired at boot.
//
// `--output` is intentionally not extracted here; the bootstrap layer
// only needs apiUrl + profile. The output format is consulted per-action
// via `program.opts()`.
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
// Resolve through the shared priority chain so the bootstrap honours the
// same rules (`config set apiUrl …`, KANBAN_API_URL, etc.) that the
// `kanban config get` command prints.
//
// Bad env / config-file entries never crash the CLI: `resolveRootConfig`
// logs a warning and falls back to the built-in default so a stray
// `KANBAN_CLI_TIMEOUT=abc` cannot take down the whole binary. The outer
// try/catch is a defensive backstop for any future config layer that
// throws synchronously — we still want a usable CLI even when the
// bootstrap step itself misbehaves.
let resolved: ReturnType<typeof resolveRootConfig>;
try {
  resolved = resolveRootConfig(
    {
      apiUrl: early.apiUrl,
      profile: early.profile,
    },
    undefined,
    process.env,
    (msg: string) => {
      process.stderr.write(`[kanban] warning: ${msg}\n`);
    }
  );
} catch (err) {
  process.stderr.write(
    `[kanban] warning: failed to resolve config (${
      (err as Error).message
    }); falling back to built-in defaults\n`
  );
  resolved = resolveRootConfig({
    apiUrl: early.apiUrl,
    profile: early.profile,
  });
}
const apiUrl = resolved.apiUrl;
const profile = resolved.profile;

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
