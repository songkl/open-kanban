// CLI entry point. Resolves runtime options from the priority chain
// (CLI flag > env var > config file > built-in default), builds the
// OAuth + Http collaborators, hands them to `createProgram` (which
// wires the full command tree in cli/src/program.ts), and parses argv.

import { Command } from "commander";
import { buildOAuthClient, createProgram } from "./src/program.js";
import { HttpClient } from "./src/http/client.js";
import { resolveRootConfig } from "./src/config.js";
import {
  parseLangFlag,
  resetLocaleCache,
  setLocale,
  t,
} from "./src/i18n/index.js";

// extractEarlyFlags scans argv for the global flags Commander consumes at
// root level (`--api-url`, `--profile`, `--lang`) *before* Commander
// sees them. Without this, the shared OAuth + Http clients would always
// be constructed against the env-var defaults — even when the user
// explicitly passed `--api-url` on the command line — because action
// handlers read `program.opts()` after parsing, but the shared clients
// are wired at boot.
//
// `--lang` lives here too so the locale resolution runs before we
// translate any Commander help text. The shared i18n state is initialised
// once at module load and applies to every command description afterwards.
//
// `--output` is intentionally not extracted here; the bootstrap layer
// only needs apiUrl + profile. The output format is consulted per-action
// via `program.opts()`.
function extractEarlyFlags(
  argv: string[]
): { apiUrl?: string; profile?: string; lang?: string } {
  const out: { apiUrl?: string; profile?: string; lang?: string } = {};
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
    } else if (a === "--lang") {
      const v = argv[i + 1];
      if (v && !v.startsWith("--")) {
        out.lang = v;
        i++;
      }
    } else if (a.startsWith("--lang=")) {
      out.lang = a.slice("--lang=".length);
    }
  }
  return out;
}

// Resolve the locale as early as possible so every translated string the
// bootstrap emits (warning lines, etc.) is rendered in the operator's
// preferred language. Priority:
//
//   1. The `--lang` CLI flag, which lets a one-off override be applied
//      without touching the environment (handy in CI / smoke scripts).
//   2. `process.env.KANBAN_LANG` (operator override)
//   3. POSIX `LC_ALL` then `LANG`
//
// `resetLocaleCache` clears any cached env-derived locale so a stale
// value from a previous run (e.g. the interactive shell REPL) does not
// leak into this invocation.
const early = extractEarlyFlags(process.argv);
const flagLang = parseLangFlag(early.lang);
resetLocaleCache();
if (flagLang) {
  setLocale(flagLang);
}
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
    `[kanban] warning: ${t("cli.bootstrap.warning.configResolve", {
      reason: (err as Error).message,
    })}\n`
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
