// `kanban config` command — manages the persistent CLI configuration.
//
// The CLI pulls its runtime settings (apiUrl, profile, output format, HTTP
// timeout) from four sources in priority order:
//
//   1. CLI flag (e.g. --api-url, --output, --profile)
//   2. Environment variable (KANBAN_API_URL, KANBAN_CLI_PROFILE,
//                            KANBAN_CLI_OUTPUT, KANBAN_CLI_TIMEOUT, NO_COLOR)
//   3. Config file on disk (default: ~/.config/kanban-cli/config.json)
//   4. Built-in default (apiUrl=http://localhost:8080, output=table, etc.)
//
// `kanban config get [key]` prints the effective value (after the full
// priority chain resolves) so operators can debug why a particular value
// was chosen; `kanban config set <key> <value>` writes the value to the
// config file so it survives across invocations.
//
// The store is intentionally tiny (a plain JSON file, no encryption —
// unlike the OAuth credentials) because the only sensitive secret in the
// CLI lives in the encrypted token store. The config file only carries
// hostnames, profile names, and output preferences.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type OutputFormat = "table" | "json" | "yaml";

/**
 * Built-in defaults applied when no flag, env var, or config-file entry
 * supplies a value. `apiUrl` matches the legacy `DEFAULT_API_URL` constant
 * in `src/http/client.ts` so a fresh install behaves the same as before
 * the config command was added.
 */
export const BUILTIN_DEFAULTS = Object.freeze({
  apiUrl: "http://localhost:8080",
  output: "table" as OutputFormat,
  profile: undefined as string | undefined,
  timeout: 30 as number,
});

/**
 * Keys recognised by the config store. Anything outside this set is
 * rejected by `parseKey` / `setConfigValue` so a typo never silently
 * writes a bogus property to disk.
 */
export const SUPPORTED_KEYS = ["apiUrl", "output", "profile", "timeout"] as const;
export type SupportedKey = (typeof SUPPORTED_KEYS)[number];

export interface CliConfigFile {
  apiUrl?: string;
  output?: OutputFormat;
  profile?: string;
  timeout?: number;
}

export interface ResolvedConfig {
  apiUrl: string;
  output: OutputFormat;
  profile: string | undefined;
  timeout: number;
}

/**
 * EnvKey is the environment-variable name that overrides a given config
 * key. Not every key has an env var; the table below is the source of
 * truth — `resolveConfig` consults it before falling back to the file.
 *
 *   apiUrl   → KANBAN_API_URL
 *   output   → KANBAN_CLI_OUTPUT
 *   profile  → KANBAN_CLI_PROFILE
 *   timeout  → KANBAN_CLI_TIMEOUT
 *
 * NO_COLOR is consulted separately by the colour helpers in
 * `src/output/color.ts`; we don't surface it through `kanban config get`
 * because it is a boolean signal (any non-empty value disables colour)
 * rather than a scalar setting.
 */
const ENV_KEY: Record<SupportedKey, string | null> = {
  apiUrl: "KANBAN_API_URL",
  output: "KANBAN_CLI_OUTPUT",
  profile: "KANBAN_CLI_PROFILE",
  timeout: "KANBAN_CLI_TIMEOUT",
};

// Acceptable values for `output`. Match Commander's existing --output flag
// ("table"|"json") and add "yaml" since the project roadmap lists it as a
// planned third format (yaml package is already in deps).
const ALLOWED_OUTPUTS: readonly string[] = ["table", "json", "yaml"];

export class InvalidConfigKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConfigKeyError";
  }
}

export class InvalidConfigValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConfigValueError";
  }
}

/**
 * Scan an argv array for explicit `--<flag>` / `--<flag>=<value>` pairs.
 * Used by the `config get` command so we can distinguish "user passed
 * --api-url on the command line" (source = cli) from "apiUrl fell through
 * to env / file / default" (sources 2-4). Commander's `program.opts()`
 * returns the resolved value (i.e. the default when the flag was absent),
 * which would otherwise report `(cli)` even for env-derived values.
 *
 * Recognised flags: --api-url, --profile, --output. The boolean
 * `--no-color` is intentionally excluded — colour is governed by the
 * separate `NO_COLOR` env var and not part of the config chain.
 *
 * When `--flag` is followed by another `--flag`, we treat the value as
 * missing and let the loop continue so the next flag is still parsed.
 */
export function extractCliFlags(
  argv: readonly string[],
  keys: readonly SupportedKey[] = ["apiUrl", "profile", "output"]
): Partial<Record<SupportedKey, string>> {
  const flagToKey: Record<string, SupportedKey> = {
    "--api-url": "apiUrl",
    "--profile": "profile",
    "--output": "output",
  };
  const out: Partial<Record<SupportedKey, string>> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let matched = false;
    for (const flag of Object.keys(flagToKey)) {
      if (a === flag) {
        matched = true;
        const v = argv[i + 1];
        if (v !== undefined && !v.startsWith("--")) {
          out[flagToKey[flag]] = v;
          i++;
        }
        // Whether or not a value was consumed, stop scanning this argv
        // slot for other flags (only one flag can match a token).
        break;
      }
      if (a.startsWith(`${flag}=`)) {
        out[flagToKey[flag]] = a.slice(flag.length + 1);
        matched = true;
        break;
      }
    }
    // `matched` is recorded for readability; no extra work needed
    // because the inner loop already handled every case.
    void matched;
  }
  // Drop keys that weren't requested so callers can subset (e.g. only
  // `--api-url`) without having to manually rebuild the result object.
  for (const k of Object.keys(out) as SupportedKey[]) {
    if (!keys.includes(k)) delete out[k];
  }
  return out;
}

/**
 * Resolve the config file path. Honours XDG_CONFIG_HOME so headless
 * containers and CI runners can override the location; otherwise falls
 * back to `~/.config/kanban-cli/config.json`. Tests inject their own path
 * to keep the user's real config untouched.
 */
export function defaultConfigPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir()
): string {
  const base = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(base, "kanban-cli", "config.json");
}

/**
 * Read the raw config file from disk. Returns an empty object when the
 * file is missing or unparseable so a corrupted file never breaks the
 * CLI — operators can run `kanban config set ...` to overwrite it.
 */
export function readConfigFile(path: string = defaultConfigPath()): CliConfigFile {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as CliConfigFile;
  } catch {
    return {};
  }
}

/**
 * Write the config to disk. The parent directory is created with mode
 * 0o700 and the file is written with mode 0o600 so a multi-user system
 * can't sniff profile names / API URLs at rest. Best-effort chmod — if
 * the platform refuses (e.g. Windows), we ignore the error rather than
 * blocking the user from saving their config.
 */
export function writeConfigFile(
  config: CliConfigFile,
  path: string = defaultConfigPath()
): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort — Windows / restricted filesystems
  }
}

/**
 * Validate that `value` is acceptable for `key`. Throws an
 * InvalidConfigValueError when the value can't be coerced. The check is
 * permissive (only forbids empty strings for required keys) so future
 * keys can opt in without touching this function — every coercion is
 * local to its branch.
 */
export function coerceConfigValue(key: SupportedKey, value: string): string | number | undefined {
  const trimmed = value.trim();
  if (key === "timeout") {
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      throw new InvalidConfigValueError(
        `invalid value for '${key}': expected positive integer, got '${value}'`
      );
    }
    return n;
  }
  if (key === "output") {
    if (!ALLOWED_OUTPUTS.includes(trimmed)) {
      throw new InvalidConfigValueError(
        `invalid value for 'output': expected one of ${ALLOWED_OUTPUTS.join(", ")}, got '${value}'`
      );
    }
    return trimmed;
  }
  if (key === "apiUrl") {
    if (trimmed.length === 0) {
      throw new InvalidConfigValueError(`invalid value for 'apiUrl': must not be empty`);
    }
    return trimmed;
  }
  if (key === "profile") {
    // Setting profile to an empty string clears the active profile.
    // We treat the empty string as `undefined` so `resolveConfig`
    // reports "no profile" downstream.
    return trimmed.length === 0 ? undefined : trimmed;
  }
  // Unreachable in practice — the type system forbids other keys via
  // the SupportedKey union. The exhaustive check is here for safety.
  throw new InvalidConfigValueError(`unsupported key: ${key}`);
}

/**
 * Parse and validate a key supplied on the command line. Throws
 * InvalidConfigKeyError so the caller can map to a friendly usage
 * message and an exit code of 1.
 */
export function parseKey(input: string): SupportedKey {
  const trimmed = input.trim();
  if ((SUPPORTED_KEYS as readonly string[]).includes(trimmed)) {
    return trimmed as SupportedKey;
  }
  throw new InvalidConfigKeyError(
    `unknown config key: '${input}' (supported: ${SUPPORTED_KEYS.join(", ")})`
  );
}

/**
 * Pluggable warning sink used by the resolver to surface bad env /
 * config-file entries without crashing the CLI. The default is a no-op
 * so pure unit tests stay quiet; the production entry point in
 * `cli/index.ts` installs a stderr-backed logger so operators see
 * "ignored $KANBAN_CLI_TIMEOUT=abc" instead of an uncaught exception.
 */
export type ResolveWarningSink = (message: string) => void;

const noopWarning: ResolveWarningSink = () => {};

/**
 * Apply the full priority chain for a single key:
 *
 *   cliValue  →  envValue  →  fileValue  →  builtinDefault
 *
 * Each layer is optional; the first one that returns a defined value
 * wins. The function is exported so individual layers can be unit-tested
 * without having to construct a fake filesystem.
 *
 * `onWarn` is consulted when an env / file value is present but fails
 * validation (e.g. `KANBAN_CLI_TIMEOUT=abc`). The CLI uses this hook to
 * log a friendly warning and fall through to the built-in default so a
 * stray environment variable never crashes the bootstrap layer.
 */
export function resolveValue<K extends SupportedKey>(
  key: K,
  cliValue: string | undefined,
  file: CliConfigFile,
  env: Record<string, string | undefined>,
  onWarn: ResolveWarningSink = noopWarning
): ResolvedConfig[K] {
  if (cliValue !== undefined) {
    return coerceConfigValue(key, cliValue) as ResolvedConfig[K];
  }
  const envName = ENV_KEY[key];
  if (envName) {
    const envValue = env[envName];
    if (envValue !== undefined && envValue !== "") {
      try {
        return coerceConfigValue(key, envValue) as ResolvedConfig[K];
      } catch (err) {
        // Bad env value: never crash the bootstrap layer over a stray
        // environment variable. Surface the issue via `onWarn` so
        // operators can still see *why* their value was ignored.
        onWarn(
          `ignored invalid ${envName}='${envValue}': ${
            (err as Error).message
          }; falling back to default`
        );
        return BUILTIN_DEFAULTS[key] as ResolvedConfig[K];
      }
    }
  }
  const fileValue = file[key];
  if (fileValue !== undefined) {
    if (key === "profile") {
      // Coerce empty profile strings to undefined so the resolved
      // value stays consistent with `coerceConfigValue`.
      const v = String(fileValue);
      return (v.length === 0 ? undefined : v) as ResolvedConfig[K];
    }
    if (key === "timeout") {
      const n = Number(fileValue);
      if (Number.isFinite(n) && n > 0 && Number.isInteger(n)) {
        return n as ResolvedConfig[K];
      }
    }
    if (key === "output") {
      const v = String(fileValue);
      if (ALLOWED_OUTPUTS.includes(v)) {
        return v as ResolvedConfig[K];
      }
    }
    if (key === "apiUrl") {
      const v = String(fileValue);
      if (v.length > 0) {
        return v as ResolvedConfig[K];
      }
    }
  }
  return BUILTIN_DEFAULTS[key] as ResolvedConfig[K];
}

/**
 * Resolve every supported key against the supplied inputs. Convenience
 * wrapper around `resolveValue` so callers that need the full picture
 * (the `kanban config get` command, the bootstrap layer) can hit one
 * function instead of looping manually.
 *
 * `onWarn` is forwarded to each `resolveValue` call so a bad env var
 * produces one warning per offending key without aborting resolution
 * of the remaining keys.
 */
export function resolveConfig(
  cliFlags: Partial<Record<SupportedKey, string | undefined>>,
  file: CliConfigFile = readConfigFile(),
  env: Record<string, string | undefined> = process.env,
  onWarn: ResolveWarningSink = noopWarning
): ResolvedConfig {
  return {
    apiUrl: resolveValue("apiUrl", cliFlags.apiUrl, file, env, onWarn),
    output: resolveValue("output", cliFlags.output, file, env, onWarn),
    profile: resolveValue("profile", cliFlags.profile, file, env, onWarn),
    timeout: resolveValue("timeout", cliFlags.timeout, file, env, onWarn),
  };
}

/**
 * Describe the *source* that ultimately supplied the effective value
 * for a single key. Used by `kanban config get` so operators can see
 * why a particular value was chosen — "from env var" vs "from config
 * file" is invaluable when an unexpected URL keeps showing up.
 */
export type ConfigSource = "cli" | "env" | "file" | "default";

export function sourceOf<K extends SupportedKey>(
  key: K,
  cliValue: string | undefined,
  file: CliConfigFile,
  env: Record<string, string | undefined>
): ConfigSource {
  if (cliValue !== undefined) return "cli";
  const envName = ENV_KEY[key];
  if (envName && env[envName] !== undefined && env[envName] !== "") return "env";
  const fileValue = file[key];
  if (fileValue !== undefined && String(fileValue).length > 0) {
    if (key === "timeout") {
      const n = Number(fileValue);
      if (Number.isFinite(n) && n > 0 && Number.isInteger(n)) return "file";
    } else if (key === "output") {
      if (ALLOWED_OUTPUTS.includes(String(fileValue))) return "file";
    } else if (key === "apiUrl" || key === "profile") {
      return "file";
    }
  }
  return "default";
}

// ---------------------------------------------------------------------------
// Public command entry points
// ---------------------------------------------------------------------------

export interface RunConfigGetOptions {
  // key optionally narrows the output to a single value. When omitted,
  // the command prints every supported key alongside its source.
  key?: string;
  // io lets the bootstrap layer and the tests redirect stdout/stderr.
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  // file is the parsed config file content. Tests inject fixtures; the
  // command default reads from the standard config path.
  file?: CliConfigFile;
  // cliFlags captures the flag values already parsed by Commander. Used
  // to populate the "source" column and to resolve the effective value.
  cliFlags?: Partial<Record<SupportedKey, string | undefined>>;
  // env lets tests inject a snapshot. Defaults to process.env.
  env?: Record<string, string | undefined>;
}

export interface ConfigGetReport {
  config: ResolvedConfig;
  sources: Record<SupportedKey, ConfigSource>;
  // configPath is the on-disk path the command consulted. Surfaced so
  // `kanban config get` (without a key) can show operators where to
  // edit the file directly.
  configPath: string;
}

/**
 * Run `kanban config get [key]`. When `key` is omitted, prints every
 * supported key in `key=value (source)` form so the output is grep-friendly
 * and easy to paste into bug reports. When `key` is supplied, prints only
 * the resolved value (no trailing newline offset issues for pipes).
 */
export async function runConfigGet(
  opts: RunConfigGetOptions = {}
): Promise<ConfigGetReport> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const env = opts.env ?? process.env;
  const cliFlags = opts.cliFlags ?? {};
  const file = opts.file ?? readConfigFile();
  const configPath = defaultConfigPath(env);
  const config = resolveConfig(cliFlags, file, env);
  const sources: Record<SupportedKey, ConfigSource> = {
    apiUrl: sourceOf("apiUrl", cliFlags.apiUrl, file, env),
    output: sourceOf("output", cliFlags.output, file, env),
    profile: sourceOf("profile", cliFlags.profile, file, env),
    timeout: sourceOf("timeout", cliFlags.timeout, file, env),
  };

  if (opts.key) {
    let parsedKey: SupportedKey;
    try {
      parsedKey = parseKey(opts.key);
    } catch (err) {
      stderr.write(`${(err as Error).message}\n`);
      throw err;
    }
    const value = config[parsedKey];
    // Print `value source` (e.g. `http://kanban.example.com env`). When
    // the value is undefined (profile unset), print `<unset>` so the
    // caller has a deterministic token to test against.
    const rendered = value === undefined ? "<unset>" : String(value);
    stdout.write(`${rendered} (${sources[parsedKey]})\n`);
  } else {
    const lines: string[] = [];
    lines.push(`config file: ${configPath}`);
    for (const k of SUPPORTED_KEYS) {
      const v = config[k];
      const rendered = v === undefined ? "<unset>" : String(v);
      lines.push(`${k}=${rendered} (${sources[k]})`);
    }
    stdout.write(lines.join("\n") + "\n");
  }
  return { config, sources, configPath };
}

export interface RunConfigSetOptions {
  // key is the config key to write. Validated by `parseKey`.
  key: string;
  // value is the raw string from argv. Validated and coerced by
  // `coerceConfigValue` so the persisted JSON always holds a typed value.
  value: string;
  // io lets tests redirect stdout/stderr.
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  // file is the existing config file content. Tests can seed it; the
  // command default reads from disk so the operation merges with whatever
  // the user already saved.
  file?: CliConfigFile;
  // path overrides the config file location. Useful for tests; default
  // uses `defaultConfigPath()`.
  path?: string;
}

/**
 * Run `kanban config set <key> <value>`. Reads the current config (if
 * any), validates the new value, and persists the merged result. The
 * function returns the persisted entry so callers / tests can assert
 * on it without re-reading the file.
 */
export async function runConfigSet(opts: RunConfigSetOptions): Promise<{
  key: SupportedKey;
  previous: string | number | undefined;
  current: string | number | undefined;
  path: string;
}> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const path = opts.path ?? defaultConfigPath();
  const parsedKey = parseKey(opts.key);
  const coerced = coerceConfigValue(parsedKey, opts.value);

  const file = opts.file ?? readConfigFile(path);
  const previousRaw = file[parsedKey];
  const previous =
    previousRaw === undefined
      ? undefined
      : parsedKey === "timeout"
        ? Number(previousRaw)
        : String(previousRaw);

  const next: CliConfigFile = { ...file };
  if (coerced === undefined) {
    // `coerceConfigValue("profile", "")` returns undefined to mean
    // "no profile". Persist an empty string so subsequent reads hit the
    // file branch and resolveConfig normalises it back to undefined.
    next[parsedKey] = "" as unknown as never;
  } else {
    (next as Record<string, unknown>)[parsedKey] = coerced;
  }
  writeConfigFile(next, path);

  const rendered = coerced === undefined ? "<unset>" : String(coerced);
  stdout.write(`set ${parsedKey}=${rendered}\n`);
  stderr.write(`saved to ${path}\n`);
  return { key: parsedKey, previous, current: coerced, path };
}
