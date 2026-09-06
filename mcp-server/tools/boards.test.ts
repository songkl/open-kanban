import { describe, it, expect, vi, beforeEach } from "vitest";
import { assertBoardAccess, getBoardHandler } from "./boards.js";

describe("assertBoardAccess", () => {
  it("returns the access level when effectiveAccess is set", () => {
    expect(assertBoardAccess({ effectiveAccess: "READ" }, "b1")).toBe("READ");
    expect(assertBoardAccess({ effectiveAccess: "WRITE" }, "b1")).toBe("WRITE");
    expect(assertBoardAccess({ effectiveAccess: "ADMIN" }, "b1")).toBe("ADMIN");
  });

  it("throws when effectiveAccess is empty string", () => {
    expect(() => assertBoardAccess({ effectiveAccess: "" }, "b1")).toThrow(
      /No access to board b1/
    );
  });

  it("throws when effectiveAccess is missing", () => {
    expect(() => assertBoardAccess({}, "b1")).toThrow(/No access to board b1/);
    expect(() => assertBoardAccess(null, "b1")).toThrow(/No access to board b1/);
  });
});

describe("getBoardHandler", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    delete process.env.KANBAN_MCP_TOKEN;
  });

  function mockApiResponse(body: any, status = 200) {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("returns board data when user has READ access", async () => {
    mockApiResponse({
      id: "b1",
      name: "Test Board",
      effectiveAccess: "READ",
      _count: { columns: 5 }
    });
    const result = await getBoardHandler("b1");
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      id: "b1",
      name: "Test Board",
      effectiveAccess: "READ"
    });
  });

  it("throws when effectiveAccess is empty string", async () => {
    mockApiResponse({
      id: "b1",
      name: "Private Board",
      effectiveAccess: ""
    });
    await expect(getBoardHandler("b1")).rejects.toThrow(/No access to board b1/);
  });

  it("throws when effectiveAccess is missing", async () => {
    mockApiResponse({
      id: "b1",
      name: "Anonymous Board"
    });
    await expect(getBoardHandler("b1")).rejects.toThrow(/No access to board b1/);
  });
});
