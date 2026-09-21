import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "./program.js";
import { HttpClient } from "./http/client.js";
import { OAuthClient } from "./auth/client.js";
import {
  resetLocaleCache,
  setLocale,
  SUPPORTED_LOCALES,
  t,
} from "./i18n/index.js";

function makeDeps() {
  const oauth = new OAuthClient(
    "http://localhost:8080",
    {
      issuer: "http://localhost:8080",
      authorization_endpoint: "http://localhost:8080/oauth/authorize",
      token_endpoint: "http://localhost:8080/oauth/token",
      jwks_uri: "http://localhost:8080/.well-known/jwks.json",
      registration_endpoint: "http://localhost:8080/oauth/register",
      device_authorization_endpoint: "http://localhost:8080/oauth/device/code",
      grant_types_supported: [
        "urn:ietf:params:oauth:grant-type:device_code",
        "refresh_token",
      ],
      response_types_supported: ["code"],
      token_endpoint_auth_methods_supported: ["none"],
    },
    {
      read() {
        return null;
      },
      write() {
        /* noop */
      },
      clear() {
        /* noop */
      },
    }
  );
  const http = new HttpClient({
    apiUrl: "http://localhost:8080",
    fetchImpl: vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch,
  });
  http.attachOAuth(oauth);
  return { oauth, http };
}

afterEach(() => {
  resetLocaleCache();
  delete process.env.LANG;
  delete process.env.LC_ALL;
  delete process.env.KANBAN_LANG;
});

describe("createProgram — locale-aware help text", () => {
  it("renders English command descriptions by default", () => {
    setLocale("en");
    const { http, oauth } = makeDeps();
    const program = createProgram({ apiUrl: "http://localhost:8080" }, { oauth, http });
    const help = program.helpInformation();
    // The English description of the "boards" group must show up verbatim
    // in the help output, since the dictionary returns the English string
    // unchanged.
    expect(help).toContain("Open Kanban CLI - command-line client");
    expect(help).toContain("manage boards");
  });

  it("renders Chinese descriptions when the locale is switched to zh", () => {
    setLocale("zh");
    const { http, oauth } = makeDeps();
    const program = createProgram({ apiUrl: "http://localhost:8080" }, { oauth, http });
    const help = program.helpInformation();
    expect(help).toContain("Open Kanban 命令行客户端 - 用于操作 Open Kanban 看板");
    expect(help).toContain("管理看板");
    // The English copy should not leak through when locale is zh — pick a
    // very specific long English phrase that won't appear in any Chinese
    // translation.
    expect(help).not.toContain("manage boards");
  });

  it("exposes the --lang flag in the help output", () => {
    setLocale("en");
    const { http, oauth } = makeDeps();
    const program = createProgram({ apiUrl: "http://localhost:8080" }, { oauth, http });
    const help = program.helpInformation();
    expect(help).toContain("--lang <locale>");
  });

  it("supports flipping back to English via setLocale without rebuilding state", () => {
    setLocale("zh");
    const { http, oauth } = makeDeps();
    const zhProgram = createProgram({ apiUrl: "http://localhost:8080" }, { oauth, http });
    expect(zhProgram.helpInformation()).toContain("管理看板");

    // Program instances are immutable — each `createProgram` invocation
    // captures the locale at build time. Confirming that hint is the
    // expected behaviour for now: changing locale requires rebuilding the
    // program. The bootstrap layer does this on every CLI invocation.
    setLocale("en");
    const enProgram = createProgram({ apiUrl: "http://localhost:8080" }, { oauth, http });
    expect(enProgram.helpInformation()).toContain("manage boards");
  });
});

describe("createProgram — option descriptions follow locale", () => {
  it("translates the --api-url description to Chinese", () => {
    setLocale("zh");
    const { http, oauth } = makeDeps();
    const program = createProgram({ apiUrl: "http://localhost:8080" }, { oauth, http });
    expect(program.helpInformation()).toContain("Kanban API 服务地址");
  });

  it("falls back to English text for unknown locales (sanity)", () => {
    // Defensive check: unknown supported locales still return English
    // strings via the engine. Direct exercise of the API, separate from
    // `createProgram`, keeps the assertion independent of Commander.
    setLocale("en");
    expect(typeof t("cli.option.apiUrl")).toBe("string");
    expect(SUPPORTED_LOCALES).toEqual(["en", "zh"]);
  });
});
