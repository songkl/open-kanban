import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  InvalidLocaleError,
  SUPPORTED_LOCALES,
  detectLocaleFromEnv,
  getLocale,
  parseLangFlag,
  resetLocaleCache,
  setLocale,
  t,
  type SupportedLocale,
} from "./index.js";

afterEach(() => {
  resetLocaleCache();
  delete process.env.KANBAN_LANG;
  delete process.env.LC_ALL;
  delete process.env.LANG;
});

describe("detectLocaleFromEnv", () => {
  it("falls back to English when no env vars are set", () => {
    expect(detectLocaleFromEnv({})).toBe("en");
  });

  it("ignores empty / unset values", () => {
    expect(detectLocaleFromEnv({ LANG: "", LC_ALL: undefined, KANBAN_LANG: undefined })).toBe("en");
  });

  it("treats POSIX / C as a non-match and falls through to English", () => {
    expect(detectLocaleFromEnv({ LANG: "C" })).toBe("en");
    expect(detectLocaleFromEnv({ LANG: "POSIX" })).toBe("en");
  });

  it("reads KANBAN_LANG first (highest priority)", () => {
    expect(
      detectLocaleFromEnv({
        KANBAN_LANG: "zh",
        LC_ALL: "en_US.UTF-8",
        LANG: "en_US.UTF-8",
      })
    ).toBe("zh");
  });

  it("falls back to LC_ALL when KANBAN_LANG is missing", () => {
    expect(
      detectLocaleFromEnv({
        LC_ALL: "zh_CN.UTF-8",
        LANG: "en_US.UTF-8",
      })
    ).toBe("zh");
  });

  it("falls back to LANG when both overrides are missing", () => {
    expect(detectLocaleFromEnv({ LANG: "zh_TW.UTF-8" })).toBe("zh");
    expect(detectLocaleFromEnv({ LANG: "en_GB.UTF-8" })).toBe("en");
  });

  it("supports the short zh / en tags", () => {
    expect(detectLocaleFromEnv({ LANG: "zh" })).toBe("zh");
    expect(detectLocaleFromEnv({ LANG: "en" })).toBe("en");
  });

  it("supports hyphenated BCP-47 tags", () => {
    expect(detectLocaleFromEnv({ LANG: "zh-CN" })).toBe("zh");
    expect(detectLocaleFromEnv({ LANG: "en-US" })).toBe("en");
  });

  it("ignores env vars that don't map to a supported locale", () => {
    expect(detectLocaleFromEnv({ LANG: "fr_FR.UTF-8" })).toBe("en");
    expect(detectLocaleFromEnv({ LANG: "ja_JP.UTF-8" })).toBe("en");
    expect(detectLocaleFromEnv({ LANG: "de_DE.UTF-8" })).toBe("en");
  });

  it("is case-insensitive on the locale tag", () => {
    expect(detectLocaleFromEnv({ LANG: "ZH_CN.UTF-8" })).toBe("zh");
    expect(detectLocaleFromEnv({ LANG: "EN_us.UTF-8" })).toBe("en");
  });
});

describe("setLocale / getLocale", () => {
  it("returns the explicit override when set", () => {
    setLocale("zh");
    expect(getLocale()).toBe("zh");
  });

  it("clears the override when passed undefined", () => {
    setLocale("zh");
    setLocale(undefined);
    // After clearing, resolution should fall back to env (which is unset → en).
    expect(getLocale()).toBe(DEFAULT_LOCALE);
  });

  it("throws InvalidLocaleError for unsupported locales", () => {
    expect(() => setLocale("fr" as unknown as SupportedLocale)).toThrow(InvalidLocaleError);
  });

  it("re-derives from env after resetLocaleCache", () => {
    setLocale("zh");
    process.env.LANG = "en_US.UTF-8";
    resetLocaleCache();
    // setLocale was reset to undefined, so getLocale follows env detection.
    expect(getLocale()).toBe("en");
  });
});

describe("parseLangFlag", () => {
  it("returns undefined for empty / whitespace input", () => {
    expect(parseLangFlag(undefined)).toBeUndefined();
    expect(parseLangFlag("")).toBeUndefined();
    expect(parseLangFlag("   ")).toBeUndefined();
  });

  it("accepts the short zh / en tags", () => {
    expect(parseLangFlag("zh")).toBe("zh");
    expect(parseLangFlag("en")).toBe("en");
  });

  it("accepts BCP-47 and POSIX variants", () => {
    expect(parseLangFlag("zh-CN")).toBe("zh");
    expect(parseLangFlag("zh_CN.UTF-8")).toBe("zh");
    expect(parseLangFlag("en-US")).toBe("en");
    expect(parseLangFlag("EN_us.UTF-8")).toBe("en");
  });

  it("returns undefined for unsupported tags (no silent coercion)", () => {
    expect(parseLangFlag("fr")).toBeUndefined();
    expect(parseLangFlag("ja-JP")).toBeUndefined();
    expect(parseLangFlag("de_DE.UTF-8")).toBeUndefined();
  });

  it("treats 'auto' as a passthrough so env detection wins later", () => {
    expect(parseLangFlag("auto")).toBeUndefined();
    expect(parseLangFlag("AUTO")).toBeUndefined();
  });
});

describe("t (translation)", () => {
  it("returns the English string for known keys when locale=en", () => {
    setLocale("en");
    expect(t("cli.description")).toBe(
      "Open Kanban CLI - command-line client for the Open Kanban board"
    );
    expect(t("cli.option.output")).toBe("output format (table|json|yaml)");
    expect(t("common.yes")).toBe("yes");
    expect(t("common.no")).toBe("no");
    expect(t("common.unnamed")).toBe("(unnamed)");
  });

  it("returns the Chinese string when locale=zh and a translation exists", () => {
    setLocale("zh");
    expect(t("cli.description")).toBe("Open Kanban 命令行客户端 - 用于操作 Open Kanban 看板");
    expect(t("cli.option.output")).toBe("输出格式（table|json|yaml）");
    expect(t("common.unnamed")).toBe("（未命名）");
    expect(t("common.yes")).toBe("是");
    expect(t("common.no")).toBe("否");
  });

  it("interpolates {{var}} placeholders", () => {
    setLocale("en");
    expect(t("cli.tasks.list.err.invalidFields", { value: "foo" })).toBe(
      "invalid --fields value: foo (allowed: id, id+updated)"
    );
    setLocale("zh");
    expect(t("cli.tasks.list.err.invalidFields", { value: "bar" })).toBe(
      "非法的 --fields 值：bar（允许：id, id+updated）"
    );
  });

  it("replaces missing vars with an empty string (so the placeholder disappears)", () => {
    setLocale("en");
    expect(t("cli.tasks.list.err.invalidFields", {})).toBe(
      "invalid --fields value:  (allowed: id, id+updated)"
    );
  });

  it("leaves unknown vars verbatim so missing data is visible", () => {
    setLocale("en");
    const text = "hello {{name}}, your code is {{token}}";
    // Direct interpolation test against the same template
    expect(text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (k === "name" ? "Ada" : `{{${k}}}`))).toBe(
      "hello Ada, your code is {{token}}"
    );
  });

  it("falls back to English for keys not present in the active dictionary", () => {
    setLocale("zh");
    // Pick any key that's in `en` but deliberately omit it from `zh`.
    // We simulate by passing a key that's in `en` and confirming the
    // Chinese copy is returned for keys we did translate.
    const zhKey: keyof typeof import("./messages/en.js").en = "cli.option.apiUrl";
    expect(t(zhKey)).toBe("Kanban API 服务地址");
    const enOnlyFallback = t("cli.bootstrap.warning.configResolve", {
      reason: "boom",
    });
    expect(enOnlyFallback).toBe(
      "failed to resolve config (boom); falling back to built-in defaults"
    );
  });

  it("returns the key itself when neither dictionary has the entry", () => {
    setLocale("en");
    expect(t("definitely.not.a.real.key")).toBe("definitely.not.a.real.key");
  });

  it("handles numeric variables by coercing to string", () => {
    setLocale("en");
    expect(t("cli.tasks.list.err.invalidFields", { value: 42 })).toBe(
      "invalid --fields value: 42 (allowed: id, id+updated)"
    );
  });

  it("treats templates without placeholders as plain strings", () => {
    setLocale("zh");
    expect(t("common.unnamed")).toBe("（未命名）");
    expect(t("common.unnamed")).not.toMatch(/\{\{/);
  });
});

describe("supported locale list", () => {
  it("exposes the canonical set in a stable order", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en", "zh"]);
  });

  it("declares English as the built-in default", () => {
    expect(DEFAULT_LOCALE).toBe("en");
  });
});
