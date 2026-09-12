// Tests for `kanban config`.
//
// The priority chain (CLI flag > env var > config file > built-in default)
// is exercised in three layers:
//
//   1. `resolveConfig` / `resolveValue` — pure resolution logic with no
//      filesystem access. We feed each layer a fake value and assert the
//      winner.
//   2. `readConfigFile` / `writeConfigFile` — the on-disk store. Tests
//      create a temp file, round-trip through read/write, and clean up.
//   3. `runConfigGet` / `runConfigSet` — the public command entry points.
//      We verify the printed output, the error paths (invalid key, bad
//      value), and the file-side effect of `set`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  BUILTIN_DEFAULTS,
  InvalidConfigKeyError,
  InvalidConfigValueError,
  SUPPORTED_KEYS,
  coerceConfigValue,
  defaultConfigPath,
  extractCliFlags,
  parseKey,
  readConfigFile,
  resolveConfig,
  resolveValue,
  runConfigGet,
  runConfigSet,
  sourceOf,
  writeConfigFile,
  type CliConfigFile,
  type SupportedKey,
} from "./config.js";

const EMPTY_ENV: Record<string, string | undefined> = {
  KANBAN_API_URL: undefined,
  KANBAN_CLI_OUTPUT: undefined,
  KANBAN_CLI_PROFILE: undefined,
  KANBAN_CLI_TIMEOUT: undefined,
  XDG_CONFIG_HOME: undefined,
};

function makeCapture() {
  let stdout = "";
  let stderr = "";
  const out = new Writable({
    write(chunk, _enc, cb) {
      stdout += chunk.toString();
      cb();
    },
  });
  const err = new Writable({
    write(chunk, _enc, cb) {
      stderr += chunk.toString();
      cb();
    },
  });
  return {
    io: {
      stdout: out as unknown as NodeJS.WritableStream,
      stderr: err as unknown as NodeJS.WritableStream,
    },
    read: () => ({ stdout, stderr }),
  };
}

describe("defaultConfigPath", () => {
  it("honours XDG_CONFIG_HOME when set", () => {
    const path = defaultConfigPath({ XDG_CONFIG_HOME: "/tmp/cfg-test" }, "/home/x");
    expect(path).toBe("/tmp/cfg-test/kanban-cli/config.json");
  });

  it("falls back to $HOME/.config when XDG_CONFIG_HOME is unset", () => {
    const path = defaultConfigPath(EMPTY_ENV, "/home/alice");
    expect(path).toBe("/home/alice/.config/kanban-cli/config.json");
  });
});

describe("extractCliFlags", () => {
  it("returns an empty object when no flags are present", () => {
    expect(extractCliFlags(["node", "kanban", "config", "get"])).toEqual({});
  });

  it("captures --key value pairs", () => {
    expect(extractCliFlags(["node", "kanban", "--api-url", "https://x"])).toEqual({
      apiUrl: "https://x",
    });
  });

  it("captures --key=value pairs", () => {
    expect(extractCliFlags(["node", "kanban", "--profile=work"])).toEqual({
      profile: "work",
    });
  });

  it("captures multiple flags in order", () => {
    expect(
      extractCliFlags([
        "node",
        "kanban",
        "--api-url",
        "https://x",
        "--output",
        "json",
        "--profile",
        "team",
      ])
    ).toEqual({
      apiUrl: "https://x",
      output: "json",
      profile: "team",
    });
  });

  it("ignores unknown flags", () => {
    expect(extractCliFlags(["node", "kanban", "--bogus", "x"])).toEqual({});
  });

  it("stops at the first non-flag value after a flag", () => {
    // `--profile --api-url https://x` should record profile=undefined
    // and apiUrl=https://x.
    expect(extractCliFlags(["node", "kanban", "--profile", "--api-url", "https://x"])).toEqual({
      apiUrl: "https://x",
    });
  });
});

describe("parseKey", () => {
  it("accepts every supported key", () => {
    for (const k of SUPPORTED_KEYS) {
      expect(parseKey(k)).toBe(k);
    }
  });

  it("trims surrounding whitespace", () => {
    expect(parseKey("  apiUrl  ")).toBe("apiUrl");
  });

  it("rejects unknown keys with InvalidConfigKeyError", () => {
    expect(() => parseKey("nope")).toThrow(InvalidConfigKeyError);
    expect(() => parseKey("")).toThrow(InvalidConfigKeyError);
  });
});

describe("coerceConfigValue", () => {
  it("accepts a positive integer for timeout", () => {
    expect(coerceConfigValue("timeout", "15")).toBe(15);
    expect(coerceConfigValue("timeout", " 30 ")).toBe(30);
  });

  it("rejects non-integer or non-positive timeouts", () => {
    expect(() => coerceConfigValue("timeout", "0")).toThrow(InvalidConfigValueError);
    expect(() => coerceConfigValue("timeout", "-5")).toThrow(InvalidConfigValueError);
    expect(() => coerceConfigValue("timeout", "abc")).toThrow(InvalidConfigValueError);
    expect(() => coerceConfigValue("timeout", "1.5")).toThrow(InvalidConfigValueError);
  });

  it("accepts whitelisted outputs", () => {
    expect(coerceConfigValue("output", "table")).toBe("table");
    expect(coerceConfigValue("output", "json")).toBe("json");
    expect(coerceConfigValue("output", "yaml")).toBe("yaml");
  });

  it("rejects unsupported output values", () => {
    expect(() => coerceConfigValue("output", "csv")).toThrow(InvalidConfigValueError);
    expect(() => coerceConfigValue("output", "")).toThrow(InvalidConfigValueError);
  });

  it("accepts non-empty apiUrl values", () => {
    expect(coerceConfigValue("apiUrl", "https://kanban.example.com")).toBe(
      "https://kanban.example.com"
    );
  });

  it("rejects empty apiUrl values", () => {
    expect(() => coerceConfigValue("apiUrl", "")).toThrow(InvalidConfigValueError);
    expect(() => coerceConfigValue("apiUrl", "   ")).toThrow(InvalidConfigValueError);
  });

  it("treats an empty profile string as `undefined`", () => {
    expect(coerceConfigValue("profile", "")).toBeUndefined();
  });

  it("preserves non-empty profile names", () => {
    expect(coerceConfigValue("profile", "work")).toBe("work");
  });
});

describe("resolveValue priority chain", () => {
  const file: CliConfigFile = {
    apiUrl: "https://from-file.example.com",
    output: "json",
    profile: "team-alpha",
    timeout: 60,
  };

  it("CLI flag wins over env var and file", () => {
    const v = resolveValue(
      "apiUrl",
      "https://from-cli.example.com",
      file,
      { ...EMPTY_ENV, KANBAN_API_URL: "https://from-env.example.com" }
    );
    expect(v).toBe("https://from-cli.example.com");
  });

  it("env var wins over the config file", () => {
    const v = resolveValue(
      "apiUrl",
      undefined,
      file,
      { ...EMPTY_ENV, KANBAN_API_URL: "https://from-env.example.com" }
    );
    expect(v).toBe("https://from-env.example.com");
  });

  it("file wins over the built-in default", () => {
    const v = resolveValue("apiUrl", undefined, file, EMPTY_ENV);
    expect(v).toBe("https://from-file.example.com");
  });

  it("falls back to the built-in default when nothing is configured", () => {
    const v = resolveValue("apiUrl", undefined, {}, EMPTY_ENV);
    expect(v).toBe(BUILTIN_DEFAULTS.apiUrl);
  });

  it("treats an empty env value as unset", () => {
    const v = resolveValue(
      "apiUrl",
      undefined,
      file,
      { ...EMPTY_ENV, KANBAN_API_URL: "" }
    );
    expect(v).toBe("https://from-file.example.com");
  });

  it("treats an empty profile file value as undefined", () => {
    const v = resolveValue("profile", undefined, { profile: "" }, EMPTY_ENV);
    expect(v).toBeUndefined();
  });

  it("ignores malformed timeout file values", () => {
    const v = resolveValue(
      "timeout",
      undefined,
      { timeout: "not-a-number" as unknown as number },
      EMPTY_ENV
    );
    expect(v).toBe(BUILTIN_DEFAULTS.timeout);
  });

  it("ignores unsupported output file values", () => {
    const v = resolveValue(
      "output",
      undefined,
      { output: "csv" as unknown as "table" },
      EMPTY_ENV
    );
    expect(v).toBe(BUILTIN_DEFAULTS.output);
  });

  it("consults KANBAN_CLI_OUTPUT for the output key", () => {
    const v = resolveValue(
      "output",
      undefined,
      file,
      { ...EMPTY_ENV, KANBAN_CLI_OUTPUT: "yaml" }
    );
    expect(v).toBe("yaml");
  });

  it("consults KANBAN_CLI_PROFILE for the profile key", () => {
    const v = resolveValue(
      "profile",
      undefined,
      {},
      { ...EMPTY_ENV, KANBAN_CLI_PROFILE: "work" }
    );
    expect(v).toBe("work");
  });

  it("consults KANBAN_CLI_TIMEOUT for the timeout key", () => {
    const v = resolveValue(
      "timeout",
      undefined,
      {},
      { ...EMPTY_ENV, KANBAN_CLI_TIMEOUT: "120" }
    );
    expect(v).toBe(120);
  });
});

describe("resolveConfig", () => {
  it("returns every key with sensible defaults", () => {
    const config = resolveConfig({}, {}, EMPTY_ENV);
    expect(config).toEqual({
      apiUrl: BUILTIN_DEFAULTS.apiUrl,
      output: BUILTIN_DEFAULTS.output,
      profile: undefined,
      timeout: BUILTIN_DEFAULTS.timeout,
    });
  });

  it("threads env vars through every supported key", () => {
    const config = resolveConfig(
      {},
      {},
      {
        ...EMPTY_ENV,
        KANBAN_API_URL: "https://env.example.com",
        KANBAN_CLI_OUTPUT: "json",
        KANBAN_CLI_PROFILE: "team",
        KANBAN_CLI_TIMEOUT: "90",
      }
    );
    expect(config).toEqual({
      apiUrl: "https://env.example.com",
      output: "json",
      profile: "team",
      timeout: 90,
    });
  });

  it("lets CLI flags override everything", () => {
    const config = resolveConfig(
      {
        apiUrl: "https://cli.example.com",
        output: "yaml",
        profile: "me",
        timeout: "10",
      },
      {
        apiUrl: "https://file.example.com",
        output: "json",
        profile: "team",
        timeout: 99,
      },
      {
        ...EMPTY_ENV,
        KANBAN_API_URL: "https://env.example.com",
        KANBAN_CLI_OUTPUT: "table",
        KANBAN_CLI_PROFILE: "work",
        KANBAN_CLI_TIMEOUT: "60",
      }
    );
    expect(config).toEqual({
      apiUrl: "https://cli.example.com",
      output: "yaml",
      profile: "me",
      timeout: 10,
    });
  });
});

describe("sourceOf", () => {
  const file: CliConfigFile = { apiUrl: "https://file.example.com", profile: "team" };

  it("reports `cli` when the CLI flag is set", () => {
    expect(sourceOf("apiUrl", "https://cli", {}, EMPTY_ENV)).toBe("cli");
  });

  it("reports `env` when the env var is set", () => {
    expect(
      sourceOf("apiUrl", undefined, {}, { ...EMPTY_ENV, KANBAN_API_URL: "x" })
    ).toBe("env");
  });

  it("reports `file` when the file has a usable value", () => {
    expect(sourceOf("apiUrl", undefined, file, EMPTY_ENV)).toBe("file");
    expect(sourceOf("profile", undefined, file, EMPTY_ENV)).toBe("file");
  });

  it("reports `default` when nothing is set", () => {
    expect(sourceOf("apiUrl", undefined, {}, EMPTY_ENV)).toBe("default");
  });

  it("ignores empty env values when computing source", () => {
    expect(
      sourceOf("apiUrl", undefined, file, { ...EMPTY_ENV, KANBAN_API_URL: "" })
    ).toBe("file");
  });
});

describe("config file round-trip", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
    delete process.env.KANBAN_CLI_OUTPUT;
    delete process.env.KANBAN_CLI_TIMEOUT;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    }
  });

  function freshFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "kanban-cfg-"));
    tempDirs.push(dir);
    return join(dir, "config.json");
  }

  it("returns {} when the file is missing", () => {
    const file = freshFile();
    expect(readConfigFile(file)).toEqual({});
  });

  it("returns {} when the file is not JSON", () => {
    const file = freshFile();
    writeFileSync(file, "not-json{", "utf8");
    expect(readConfigFile(file)).toEqual({});
  });

  it("returns {} when the file is an array", () => {
    const file = freshFile();
    writeFileSync(file, "[]", "utf8");
    expect(readConfigFile(file)).toEqual({});
  });

  it("returns the parsed object on success", () => {
    const file = freshFile();
    writeFileSync(file, JSON.stringify({ apiUrl: "https://x", timeout: 12 }), "utf8");
    expect(readConfigFile(file)).toEqual({ apiUrl: "https://x", timeout: 12 });
  });

  it("writes the config with parent dir + 0o600 permissions", () => {
    const file = freshFile();
    writeConfigFile({ apiUrl: "https://y" }, file);
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, "utf8");
    expect(JSON.parse(raw)).toEqual({ apiUrl: "https://y" });
  });

  it("creates parent directories on demand", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-cfg-nested-"));
    tempDirs.push(dir);
    const file = join(dir, "nested", "config.json");
    writeConfigFile({ profile: "work" }, file);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ profile: "work" });
  });
});

describe("runConfigGet", () => {
  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
    delete process.env.KANBAN_CLI_OUTPUT;
    delete process.env.KANBAN_CLI_TIMEOUT;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints every supported key alongside its source", async () => {
    const cap = makeCapture();
    const report = await runConfigGet({
      io: cap.io,
      env: EMPTY_ENV,
      cliFlags: {},
      file: {},
    });
    expect(report.config).toEqual({
      apiUrl: BUILTIN_DEFAULTS.apiUrl,
      output: BUILTIN_DEFAULTS.output,
      profile: undefined,
      timeout: BUILTIN_DEFAULTS.timeout,
    });
    const { stdout } = cap.read();
    expect(stdout).toContain("apiUrl=http://localhost:8080 (default)");
    expect(stdout).toContain("output=table (default)");
    expect(stdout).toContain("profile=<unset> (default)");
    expect(stdout).toContain("timeout=30 (default)");
    expect(stdout).toContain("config file:");
  });

  it("prints the value + source for a single key", async () => {
    const cap = makeCapture();
    await runConfigGet({
      io: cap.io,
      env: EMPTY_ENV,
      cliFlags: {},
      file: { apiUrl: "https://from-file.example.com" },
      key: "apiUrl",
    });
    const { stdout } = cap.read();
    expect(stdout.trim()).toBe("https://from-file.example.com (file)");
  });

  it("reports env when the env var is set", async () => {
    const cap = makeCapture();
    await runConfigGet({
      io: cap.io,
      env: { ...EMPTY_ENV, KANBAN_API_URL: "https://env.example.com" },
      cliFlags: {},
      file: {},
      key: "apiUrl",
    });
    const { stdout } = cap.read();
    expect(stdout.trim()).toBe("https://env.example.com (env)");
  });

  it("reports cli when a CLI flag is set", async () => {
    const cap = makeCapture();
    await runConfigGet({
      io: cap.io,
      env: EMPTY_ENV,
      cliFlags: { apiUrl: "https://cli.example.com" },
      file: {},
      key: "apiUrl",
    });
    const { stdout } = cap.read();
    expect(stdout.trim()).toBe("https://cli.example.com (cli)");
  });

  it("renders profile=<unset> when no profile is configured", async () => {
    const cap = makeCapture();
    await runConfigGet({
      io: cap.io,
      env: EMPTY_ENV,
      cliFlags: {},
      file: {},
      key: "profile",
    });
    const { stdout } = cap.read();
    expect(stdout.trim()).toBe("<unset> (default)");
  });

  it("throws InvalidConfigKeyError on an unknown key", async () => {
    const cap = makeCapture();
    await expect(
      runConfigGet({ io: cap.io, env: EMPTY_ENV, cliFlags: {}, file: {}, key: "bogus" })
    ).rejects.toBeInstanceOf(InvalidConfigKeyError);
    expect(cap.read().stderr).toContain("unknown config key");
  });
});

describe("runConfigSet", () => {
  const tempDirs: string[] = [];
  let file: string;

  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
    delete process.env.KANBAN_CLI_OUTPUT;
    delete process.env.KANBAN_CLI_TIMEOUT;
    delete process.env.XDG_CONFIG_HOME;
    const dir = mkdtempSync(join(tmpdir(), "kanban-cfg-set-"));
    tempDirs.push(dir);
    file = join(dir, "config.json");
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    }
    vi.restoreAllMocks();
  });

  it("writes a brand-new config file with the supplied key", async () => {
    const cap = makeCapture();
    const result = await runConfigSet({
      key: "apiUrl",
      value: "https://new.example.com",
      io: cap.io,
      path: file,
    });
    expect(result.key).toBe("apiUrl");
    expect(result.current).toBe("https://new.example.com");
    expect(result.previous).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      apiUrl: "https://new.example.com",
    });
    const { stdout } = cap.read();
    expect(stdout).toContain("set apiUrl=https://new.example.com");
    expect(cap.read().stderr).toContain(`saved to ${file}`);
  });

  it("merges with existing entries rather than overwriting the file", async () => {
    writeConfigFile({ profile: "work" }, file);
    const cap = makeCapture();
    await runConfigSet({
      key: "apiUrl",
      value: "https://merge.example.com",
      io: cap.io,
      path: file,
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      profile: "work",
      apiUrl: "https://merge.example.com",
    });
    void cap;
  });

  it("coerces the timeout string into a number", async () => {
    const cap = makeCapture();
    const result = await runConfigSet({
      key: "timeout",
      value: "45",
      io: cap.io,
      path: file,
    });
    expect(result.current).toBe(45);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ timeout: 45 });
    void cap;
  });

  it("treats an empty profile as clearing the active profile", async () => {
    writeConfigFile({ profile: "work" }, file);
    const cap = makeCapture();
    const result = await runConfigSet({
      key: "profile",
      value: "",
      io: cap.io,
      path: file,
    });
    expect(result.current).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ profile: "" });
    void cap;
  });

  it("rejects unknown keys with InvalidConfigKeyError", async () => {
    const cap = makeCapture();
    await expect(
      runConfigSet({ key: "nope", value: "x", io: cap.io, path: file })
    ).rejects.toBeInstanceOf(InvalidConfigKeyError);
    expect(existsSync(file)).toBe(false);
  });

  it("rejects bad values with InvalidConfigValueError", async () => {
    const cap = makeCapture();
    await expect(
      runConfigSet({ key: "timeout", value: "abc", io: cap.io, path: file })
    ).rejects.toBeInstanceOf(InvalidConfigValueError);
    expect(existsSync(file)).toBe(false);
  });

  it("survives a corrupt existing config file by starting from scratch", async () => {
    writeFileSync(file, "not-json{", "utf8");
    const cap = makeCapture();
    const result = await runConfigSet({
      key: "output",
      value: "json",
      io: cap.io,
      path: file,
    });
    expect(result.current).toBe("json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ output: "json" });
    void cap;
  });
});

describe("priority integration: CLI > env > file > default", () => {
  // A single end-to-end pass through every layer. We construct a real
  // config file on disk, set every env var, and pass every CLI flag;
  // then we assert the chain resolves as expected for each key.
  const tempDirs: string[] = [];
  let file: string;

  beforeEach(() => {
    delete process.env.KANBAN_API_URL;
    delete process.env.KANBAN_CLI_PROFILE;
    delete process.env.KANBAN_CLI_OUTPUT;
    delete process.env.KANBAN_CLI_TIMEOUT;
    delete process.env.XDG_CONFIG_HOME;
    const dir = mkdtempSync(join(tmpdir(), "kanban-cfg-prio-"));
    tempDirs.push(dir);
    file = join(dir, "config.json");
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    }
    vi.restoreAllMocks();
  });

  it("picks CLI > env > file > default for every supported key", async () => {
    writeConfigFile(
      {
        apiUrl: "https://file.example.com",
        output: "json",
        profile: "team-file",
        timeout: 99,
      },
      file
    );
    const env: Record<string, string | undefined> = {
      ...EMPTY_ENV,
      KANBAN_API_URL: "https://env.example.com",
      KANBAN_CLI_OUTPUT: "yaml",
      KANBAN_CLI_PROFILE: "team-env",
      KANBAN_CLI_TIMEOUT: "75",
    };
    // Step 1: only the file is set.
    const fileOnly = resolveConfig({}, readConfigFile(file), EMPTY_ENV);
    expect(fileOnly).toEqual({
      apiUrl: "https://file.example.com",
      output: "json",
      profile: "team-file",
      timeout: 99,
    });

    // Step 2: env wins over the file.
    const fileAndEnv = resolveConfig({}, readConfigFile(file), env);
    expect(fileAndEnv.apiUrl).toBe("https://env.example.com");
    expect(fileAndEnv.output).toBe("yaml");
    expect(fileAndEnv.profile).toBe("team-env");
    expect(fileAndEnv.timeout).toBe(75);

    // Step 3: CLI flags override env.
    const cliWins = resolveConfig(
      {
        apiUrl: "https://cli.example.com",
        output: "table",
        profile: "cli",
        timeout: "5",
      },
      readConfigFile(file),
      env
    );
    expect(cliWins).toEqual({
      apiUrl: "https://cli.example.com",
      output: "table",
      profile: "cli",
      timeout: 5,
    });
  });
});

// Pull SupportedKey from the module so the test surface stays in sync
// with the implementation. (The import is exercised below to make sure
// the symbol is exported correctly; it does not need to be referenced
// inside the tests themselves.)
type _AssertSupportedKeyExported = SupportedKey;
