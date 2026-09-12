// Global CLI configuration.
//
// Two things live here today:
//
//   * The `KANBAN_API_URL` and `KANBAN_CLI_PROFILE` defaults used by every
//     command (read once from `process.env` at module load).
//   * A writeable `setColorOverride` / `getColorOverride` pair that the
//     root `--no-color` flag uses to communicate with `createContext`
//     without forcing every command to thread an extra option through
//     its `Run*Options` interface.
//
// Keeping this state in one place means adding a new global flag (e.g.
// `--profile`) only requires touching `index.ts` and `config.ts`.

import type { ColorLevel } from "./output/color.js";

const DEFAULT_API_URL = process.env.KANBAN_API_URL || "http://localhost:8080";
const DEFAULT_PROFILE = process.env.KANBAN_CLI_PROFILE;
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

export function getRootConfig(): RootConfig {
  return {
    apiUrl: DEFAULT_API_URL,
    profile: DEFAULT_PROFILE,
    appName: DEFAULT_APP_NAME,
  };
}