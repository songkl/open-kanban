// Global CLI configuration.
//
// Three responsibilities live here:
//
//   1. Resolving the runtime options the OAuth + Http collaborators need
//      at boot. The resolution chain is:
//        CLI flag > env var > config file > built-in default
//      and is implemented by `resolveRootConfig` (delegated to
//      `commands/config.ts` so the `kanban config get` command shares
//      exactly the same logic).
//   2. A writeable `setColorOverride` / `getColorOverride` pair that the
//      root `--no-color` flag uses to communicate with `createContext`
//      without forcing every command to thread an extra option through
//      its `Run*Options` interface.
//   3. The `RootConfig` value the program builder reads when wiring
//      action handlers.
//
// Keeping this state in one place means adding a new global flag (e.g.
// `--profile`) only requires touching `index.ts`, `program.ts`, and the
// resolution chain — nothing else.

import type { ColorLevel } from "./output/color.js";
import {
  resolveConfig,
  type CliConfigFile,
  type ResolvedConfig,
  type SupportedKey,
} from "./commands/config.js";

const DEFAULT_APP_NAME = "kanban-cli";

/**
 * Global colour override set by the CLI root after parsing `--no-color`
 * (or `--color=off`). `undefined` means "auto" — `createContext` will fall
 * back to its own NO_COLOR/FORCE_COLOR/TTY detection.
 */
let colorOverride: ColorLevel | undefined = undefined;

export function setColorOverride(level: ColorLevel | undefined): void {
  colorOverride = level;
}

export function getColorOverride(): ColorLevel | undefined {
  return colorOverride;
}

export interface RootConfig {
  apiUrl: string;
  profile: string | undefined;
  appName: string;
}

/**
 * Build a RootConfig by running the priority chain for `apiUrl` and
 * `profile`. `cliFlags` should contain the values parsed from argv; the
 * helper pulls them out of `process.argv` when called without an
 * argument so the entry-point can call `getRootConfig()` without having
 * to thread the parsed flags through every layer.
 *
 * `onWarn` is forwarded to `resolveConfig` so callers (typically the
 * bootstrap layer in `cli/index.ts`) can surface bad env / file values
 * instead of crashing over a stray `KANBAN_CLI_TIMEOUT=abc`.
 */
export function resolveRootConfig(
  cliFlags: Partial<Record<SupportedKey, string | undefined>> = {},
  file: CliConfigFile | undefined = undefined,
  env: Record<string, string | undefined> = process.env,
  onWarn?: import("./commands/config.js").ResolveWarningSink
): ResolvedConfig {
  return resolveConfig(cliFlags, file, env, onWarn);
}

/**
 * Backwards-compatible convenience wrapper that maps the resolved config
 * to the legacy RootConfig shape consumed by `createProgram` and the
 * `OAuthClient` builder. New code should prefer `resolveRootConfig` so
 * it gets the full set (apiUrl / output / profile / timeout).
 */
export function getRootConfig(): RootConfig {
  const resolved = resolveRootConfig();
  return {
    apiUrl: resolved.apiUrl,
    profile: resolved.profile,
    appName: DEFAULT_APP_NAME,
  };
}

export { DEFAULT_APP_NAME };
