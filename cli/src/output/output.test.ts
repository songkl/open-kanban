// Tests for the shared `cli/src/output/` helpers.
//
// We stub `chalk` to verify that:
//
//   * color is automatically disabled when stdout is non-TTY
//   * NO_COLOR / FORCE_COLOR env vars win over the default
//   * the `--no-color` / `--color` flag values are parsed correctly
//   * the JSON formatter produces pretty output with a trailing newline
//   * the table renderers respect the palette and surface field values
//
// These tests intentionally avoid touching Commander or HttpClient so the
// output module stays reusable.

import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPalette,
  parseColorFlag,
  resolveColorLevel,
} from "./color.js";
import {
  CommandContext,
  IoStreams,
  createContext,
  defaultCell,
  emitListReport,
  emitRecordReport,
  emitReport,
  formatJson,
  formatStructured,
  formatYaml,
  normalizeFields,
  projectFields,
  reportNotFound,
  resolveOutputFormat,
  stripTrailingSlash,
} from "./format.js";
import {
  defaultLabelFor,
  makeLabelFor,
  renderListTable,
  renderRecordTable,
} from "./table.js";

function makeIo(): { io: IoStreams; read: () => { stdout: string; stderr: string } } {
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

function fakeTtyStream(): NodeJS.WritableStream {
  return { isTTY: true, write: () => true } as unknown as NodeJS.WritableStream;
}

describe("color", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("disables color when stdout is not a TTY", () => {
    expect(resolveColorLevel({ stream: makeIo().io.stdout })).toBe("off");
  });

  it("enables color when stdout is a TTY", () => {
    expect(resolveColorLevel({ stream: fakeTtyStream() })).toBe("on");
  });

  it("respects NO_COLOR (any non-empty value)", () => {
    expect(resolveColorLevel({ stream: fakeTtyStream(), env: { NO_COLOR: "1" } })).toBe("off");
    expect(resolveColorLevel({ stream: fakeTtyStream(), env: { NO_COLOR: "true" } })).toBe("off");
  });

  it("respects FORCE_COLOR=0 / false / off", () => {
    for (const v of ["0", "false", "off", "no"]) {
      expect(resolveColorLevel({ stream: fakeTtyStream(), env: { FORCE_COLOR: v } })).toBe("off");
    }
  });

  it("respects FORCE_COLOR=1 / true / on", () => {
    for (const v of ["1", "true", "on", "yes"]) {
      expect(resolveColorLevel({ stream: makeIo().io.stdout, env: { FORCE_COLOR: v } })).toBe("on");
    }
  });

  it("lets the forced flag win over the environment", () => {
    expect(
      resolveColorLevel({
        forced: "on",
        stream: makeIo().io.stdout,
        env: { NO_COLOR: "1" },
      })
    ).toBe("on");
  });

  it("returns a passthrough palette when color is off", () => {
    const palette = createPalette({ forced: "off" });
    expect(palette.level).toBe("off");
    expect(palette.bold("x")).toBe("x");
    expect(palette.red("x")).toBe("x");
    expect(palette.cyan("x")).toBe("x");
    expect(palette.gray("x")).toBe("x");
    expect(palette.green("x")).toBe("x");
    expect(palette.yellow("x")).toBe("x");
    expect(palette.dim("x")).toBe("x");
  });

  it("returns a wrapping palette when color is on", () => {
    const palette = createPalette({ forced: "on" });
    expect(palette.level).toBe("on");
    // chalk's bold wrapper adds ANSI escapes; assert that a non-empty change happens.
    expect(palette.bold("x")).not.toBe("x");
  });

  it("parses --no-color (boolean false) as off", () => {
    expect(parseColorFlag(false)).toBe("off");
  });

  it("parses --color (boolean true) as on", () => {
    expect(parseColorFlag(true)).toBe("on");
  });

  it("parses --color=auto and unknown values as undefined", () => {
    expect(parseColorFlag("auto")).toBeUndefined();
    expect(parseColorFlag("banana")).toBeUndefined();
    expect(parseColorFlag(undefined)).toBeUndefined();
    expect(parseColorFlag(42)).toBeUndefined();
  });

  it("parses --color=on / --color=off / --color=yes / --color=no", () => {
    expect(parseColorFlag("on")).toBe("on");
    expect(parseColorFlag("off")).toBe("off");
    expect(parseColorFlag("yes")).toBe("on");
    expect(parseColorFlag("no")).toBe("off");
    expect(parseColorFlag(" ON ")).toBe("on");
  });
});

describe("format helpers", () => {
  it("resolveOutputFormat normalises known values and defaults unknowns", () => {
    expect(resolveOutputFormat("json")).toBe("json");
    expect(resolveOutputFormat("JSON")).toBe("json");
    expect(resolveOutputFormat("table")).toBe("table");
    expect(resolveOutputFormat("")).toBe("table");
    expect(resolveOutputFormat(undefined)).toBe("table");
    expect(resolveOutputFormat("xml")).toBe("table");
    expect(resolveOutputFormat(42)).toBe("table");
  });

  it("stripTrailingSlash removes one or more trailing slashes", () => {
    expect(stripTrailingSlash("http://x")).toBe("http://x");
    expect(stripTrailingSlash("http://x/")).toBe("http://x");
    expect(stripTrailingSlash("http://x///")).toBe("http://x");
  });

  it("formatJson produces pretty output with a trailing newline", () => {
    const out = formatJson({ a: 1, b: ["x", "y"] });
    expect(out.endsWith("\n")).toBe(true);
    expect(JSON.parse(out.trim())).toEqual({ a: 1, b: ["x", "y"] });
    expect(out).toContain("\n  ");
  });

  it("defaultCell handles null/undefined/Date/boolean/number/object", () => {
    expect(defaultCell(null)).toBe("");
    expect(defaultCell(undefined)).toBe("");
    expect(defaultCell("")).toBe("");
    expect(defaultCell("hi")).toBe("hi");
    expect(defaultCell(true)).toBe("yes");
    expect(defaultCell(false)).toBe("no");
    expect(defaultCell(0)).toBe("0");
    expect(defaultCell(42)).toBe("42");
    expect(defaultCell(Number.NaN)).toBe("");
    expect(defaultCell(Number.POSITIVE_INFINITY)).toBe("");
    expect(defaultCell(new Date("2026-01-02T03:04:05.000Z"))).toBe(
      "2026-01-02T03:04:05.000Z"
    );
    expect(defaultCell(new Date("not a date"))).toBe("");
    expect(defaultCell({ a: 1 })).toBe('{"a":1}');
  });

  it("projectFields keeps field order and drops unknowns", () => {
    const out = projectFields({ a: 1, b: 2, c: 3 }, ["c", "a", "missing"]);
    expect(Object.keys(out)).toEqual(["c", "a"]);
    expect(out).toEqual({ a: 1, c: 3 });
  });

  it("normalizeFields falls back to defaults, dedupes, drops unknowns", () => {
    const defaults = ["id", "name"];
    const allowed = ["id", "name", "createdAt"];
    expect(normalizeFields(undefined, defaults, allowed)).toEqual(["id", "name"]);
    expect(normalizeFields([], defaults, allowed)).toEqual(["id", "name"]);
    expect(normalizeFields([" name ", "id"], defaults, allowed)).toEqual(["name", "id"]);
    expect(normalizeFields(["id", "id", "bogus", ""], defaults, allowed)).toEqual(["id"]);
    expect(normalizeFields(["bogus"], defaults, allowed)).toEqual(["id", "name"]);
    expect(normalizeFields(["createdAt", "createdAt"], defaults, allowed)).toEqual(["createdAt"]);
  });

  it("createContext normalises the API URL and builds a palette", () => {
    const { io } = makeIo();
    const ctx = createContext({ apiUrl: "http://x/", io, colorForced: "off" });
    expect(ctx.apiUrl).toBe("http://x");
    expect(ctx.format).toBe("table");
    expect(ctx.io.stdout).toBe(io.stdout);
    expect(ctx.palette.level).toBe("off");
  });
});

describe("emitReport dispatch", () => {
  function ctxWith(forced: "on" | "off"): CommandContext {
    const { io } = makeIo();
    return createContext({ apiUrl: "http://x", io, colorForced: forced });
  }

  it("writes JSON when format=json", () => {
    const { io, read } = makeIo();
    const ctx: CommandContext = {
      apiUrl: "http://x",
      format: "json",
      io,
      palette: createPalette({ forced: "off" }),
    };
    emitReport({ a: 1 }, ctx, () => "should not be called");
    const { stdout } = read();
    expect(JSON.parse(stdout.trim())).toEqual({ a: 1 });
  });

  it("writes a table (renderer-supplied) when format=table", () => {
    const { io, read } = makeIo();
    const ctx: CommandContext = {
      apiUrl: "http://x",
      format: "table",
      io,
      palette: createPalette({ forced: "off" }),
    };
    emitReport({ a: 1 }, ctx, () => "rendered body");
    const { stdout } = read();
    expect(stdout).toBe("rendered body\n");
  });

  it("emitListReport builds a list-shaped table", () => {
    const { io, read } = makeIo();
    const ctx: CommandContext = {
      apiUrl: "http://x",
      format: "table",
      io,
      palette: createPalette({ forced: "off" }),
    };
    emitListReport(
      { apiUrl: "http://x", rows: [{ id: "1" }, { id: "2" }] },
      ctx,
      {
        title: "Boards",
        fields: ["id"],
        rows: [{ id: "1" }, { id: "2" }],
        renderField: (r, f) => String((r as Record<string, unknown>)[f] ?? ""),
      }
    );
    const { stdout } = read();
    expect(stdout).toContain("Boards");
    expect(stdout).toContain("http://x");
    expect(stdout).toContain("1");
    expect(stdout).toContain("2");
  });

  it("emitRecordReport builds a key/value table", () => {
    const { io, read } = makeIo();
    const ctx: CommandContext = {
      apiUrl: "http://x",
      format: "table",
      io,
      palette: createPalette({ forced: "off" }),
    };
    emitRecordReport(
      { apiUrl: "http://x", record: { id: "1", name: "Alpha" } },
      ctx,
      {
        title: "Board",
        fields: ["id", "name"],
        values: { id: "1", name: "Alpha" },
        renderField: (_k, v) => String(v ?? ""),
      }
    );
    const { stdout } = read();
    expect(stdout).toContain("Board");
    expect(stdout).toContain("id: 1");
    expect(stdout).toContain("name: Alpha");
  });

  it("reportNotFound writes a red stderr line (or passthrough when off)", () => {
    const { io, read } = makeIo();
    const ctx: CommandContext = {
      apiUrl: "http://x",
      format: "table",
      io,
      palette: createPalette({ forced: "off" }),
    };
    reportNotFound(ctx, "board", "ghost");
    const { stderr } = read();
    expect(stderr).toBe("board not found: ghost\n");
  });

  it("reportNotFound emits real ANSI escapes when color is on", () => {
    const { io, read } = makeIo();
    const ctx: CommandContext = {
      apiUrl: "http://x",
      format: "table",
      io,
      palette: createPalette({ forced: "on" }),
    };
    reportNotFound(ctx, "board", "ghost");
    const { stderr } = read();
    expect(stderr).toContain("board not found: ghost");
    // chalk adds an ANSI escape (starts with \u001b[) — assert one is present
    expect(stderr).toMatch(/\u001b\[/);
  });
});

describe("table renderers", () => {
  const palette = createPalette({ forced: "off" });

  it("renderListTable writes a header + empty-state placeholder when rows is empty", () => {
    const out = renderListTable({
      title: "Boards",
      apiUrl: "http://x",
      emptyMessage: "no boards",
      fields: ["id"],
      rows: [],
      renderField: () => "",
      palette,
    });
    expect(out).toContain("Boards");
    expect(out).toContain("http://x");
    expect(out).toContain("no boards");
  });

  it("renderListTable writes a header + table when rows is non-empty", () => {
    const out = renderListTable({
      title: "Boards",
      apiUrl: "http://x",
      fields: ["id", "name"],
      rows: [
        { id: "1", name: "Alpha" },
        { id: "2", name: "Beta" },
      ],
      renderField: (r, f) => String((r as Record<string, unknown>)[f] ?? ""),
      palette,
    });
    expect(out).toContain("Boards");
    expect(out).toContain("http://x");
    expect(out).toContain("Alpha");
    expect(out).toContain("Beta");
    expect(out).toContain("1");
    expect(out).toContain("2");
  });

  it("renderListTable applies labelFor renames", () => {
    const out = renderListTable({
      title: "Boards",
      apiUrl: "http://x",
      fields: ["columnCount"],
      rows: [{ columnCount: 4 }],
      renderField: (r, f) => String((r as Record<string, unknown>)[f] ?? ""),
      labelFor: makeLabelFor({ columnCount: "columns" }),
      palette,
    });
    expect(out).toContain("columns");
  });

  it("renderRecordTable emits one bold-label row per field", () => {
    const out = renderRecordTable({
      title: "Board",
      apiUrl: "http://x",
      fields: ["id", "name"],
      values: { id: "b1", name: "Alpha" },
      renderField: (_k, v) => String(v ?? ""),
      palette,
    });
    expect(out).toContain("Board");
    expect(out).toContain("http://x");
    expect(out).toContain("id: b1");
    expect(out).toContain("name: Alpha");
  });

  it("defaultLabelFor and makeLabelFor behave as expected", () => {
    expect(defaultLabelFor("anything")).toBe("anything");
    const labelFor = makeLabelFor({ x: "y" });
    expect(labelFor("x")).toBe("y");
    expect(labelFor("z")).toBe("z");
  });
});

describe("formatYaml", () => {
  it("serialises objects as YAML with a trailing newline", () => {
    const out = formatYaml({ apiUrl: "http://x", boards: [{ id: "b1" }] });
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain("apiUrl: http://x");
    expect(out).toContain("boards:");
    expect(out).toContain("id: b1");
  });

  it("serialises arrays at the top level", () => {
    const out = formatYaml([{ id: "a" }, { id: "b" }]);
    expect(out).toContain("- id: a");
    expect(out).toContain("- id: b");
  });

  it("falls back to a placeholder when the payload cannot be serialised", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    const out = formatYaml(a);
    expect(typeof out).toBe("string");
  });
});

describe("formatStructured", () => {
  it("returns JSON for the json format", () => {
    const out = formatStructured({ a: 1 }, "json");
    expect(JSON.parse(out.trim())).toEqual({ a: 1 });
  });

  it("returns YAML for the yaml format", () => {
    const out = formatStructured({ a: 1 }, "yaml");
    expect(out).toContain("a: 1");
  });

  it("returns an empty string for table format (callers render their own table)", () => {
    expect(formatStructured({ a: 1 }, "table")).toBe("");
  });
});

describe("resolveOutputFormat (extended)", () => {
  it("recognises yaml / yml as the yaml format", () => {
    expect(resolveOutputFormat("yaml")).toBe("yaml");
    expect(resolveOutputFormat("YAML")).toBe("yaml");
    expect(resolveOutputFormat("yml")).toBe("yaml");
    expect(resolveOutputFormat("  Yaml  ")).toBe("yaml");
  });
});

describe("snapshot-style table output", () => {
  // These tests pin down the *exact* bytes the table renderer emits so
  // that future formatting tweaks surface as a test diff. The colour
  // palette is forced off so the assertions don't depend on TTY detection.
  const palette = createPalette({ forced: "off" });

  it("renderListTable matches the canonical 2-row layout", () => {
    const out = renderListTable({
      title: "Boards",
      apiUrl: "http://x",
      fields: ["id", "name"],
      rows: [
        { id: "b1", name: "Alpha" },
        { id: "b2", name: "Beta" },
      ],
      renderField: (r, f) => String((r as Record<string, unknown>)[f] ?? ""),
      palette,
    });
    expect(out).toMatchInlineSnapshot(`
      "Boards  http://x
      ┌────┬───────┐
      │ id │ name  │
      ├────┼───────┤
      │ b1 │ Alpha │
      ├────┼───────┤
      │ b2 │ Beta  │
      └────┴───────┘"
    `);
  });

  it("renderListTable renders the empty-state placeholder without a grid", () => {
    const out = renderListTable({
      title: "Boards",
      apiUrl: "http://x",
      emptyMessage: "no boards",
      fields: ["id"],
      rows: [],
      renderField: () => "",
      palette,
    });
    expect(out).toMatchInlineSnapshot(`
      "Boards  http://x
        no boards"
    `);
  });

  it("renderRecordTable matches the canonical key/value layout", () => {
    const out = renderRecordTable({
      title: "Board",
      apiUrl: "http://x",
      fields: ["id", "name"],
      values: { id: "b1", name: "Alpha" },
      renderField: (_k, v) => String(v ?? ""),
      palette,
    });
    expect(out).toMatchInlineSnapshot(`
      "Board  http://x
        id: b1
        name: Alpha"
    `);
  });

  it("emitReport writes the JSON snapshot when format=json", () => {
    const { io, read } = makeIo();
    const ctx: CommandContext = {
      apiUrl: "http://x",
      format: "json",
      io,
      palette: createPalette({ forced: "off" }),
    };
    emitReport(
      { apiUrl: "http://x", items: [{ id: "b1" }] },
      ctx,
      () => "should not be called"
    );
    const expected = JSON.stringify(
      { apiUrl: "http://x", items: [{ id: "b1" }] },
      null,
      2
    );
    expect(read().stdout).toBe(expected + "\n");
  });

  it("emitReport writes the YAML snapshot when format=yaml", () => {
    const { io, read } = makeIo();
    const ctx: CommandContext = {
      apiUrl: "http://x",
      format: "yaml",
      io,
      palette: createPalette({ forced: "off" }),
    };
    emitReport(
      { apiUrl: "http://x", items: [{ id: "b1" }] },
      ctx,
      () => "should not be called"
    );
    const expected =
      "apiUrl: http://x\nitems:\n  - id: b1\n";
    const out = read().stdout;
    // The `yaml` package adds a trailing newline before the document-end
    // marker; trim before comparing so the assertion is robust against
    // formatting tweaks in the dependency.
    expect(out.trimEnd()).toBe(expected.trimEnd());
    expect(out.endsWith("\n")).toBe(true);
  });

  it("emitReport falls back to the table renderer when format=table", () => {
    const { io, read } = makeIo();
    const ctx: CommandContext = {
      apiUrl: "http://x",
      format: "table",
      io,
      palette: createPalette({ forced: "off" }),
    };
    emitReport(
      { apiUrl: "http://x" },
      ctx,
      (r, _c) => `header:${r.apiUrl}`
    );
    expect(read().stdout).toBe("header:http://x\n");
  });
});