import { describe, expect, it, vi } from "vitest";
import { resolveLoginMode } from "./program.js";

describe("resolveLoginMode", () => {
  it("returns 'human' when --as-human is set without prompting", async () => {
    const prompt = vi.fn();
    const mode = await resolveLoginMode(
      { asHuman: true },
      {
        // Even when stdin is a TTY the explicit flag wins — the
        // s-1231 / s-1246 contract is that --as-human / --as-agent
        // are authoritative.
        stdin: { isTTY: true } as unknown as NodeJS.ReadableStream,
        prompt,
      }
    );
    expect(mode).toBe("human");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("returns 'agent' when --as-agent is set without prompting", async () => {
    const prompt = vi.fn();
    const mode = await resolveLoginMode(
      { asAgent: true },
      {
        stdin: { isTTY: true } as unknown as NodeJS.ReadableStream,
        prompt,
      }
    );
    expect(mode).toBe("agent");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("defaults to 'agent' on non-TTY stdin (CI / e2e / piped scripts)", async () => {
    const prompt = vi.fn();
    const mode = await resolveLoginMode(
      {},
      {
        stdin: { isTTY: false } as unknown as NodeJS.ReadableStream,
        prompt,
      }
    );
    expect(mode).toBe("agent");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("defaults to 'agent' when stdin has no isTTY flag (non-interactive)", async () => {
    const prompt = vi.fn();
    const mode = await resolveLoginMode(
      {},
      {
        stdin: {} as unknown as NodeJS.ReadableStream,
        prompt,
      }
    );
    expect(mode).toBe("agent");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("falls back to 'agent' when stdin is a TTY but no prompt was injected", async () => {
    const mode = await resolveLoginMode(
      {},
      {
        stdin: { isTTY: true } as unknown as NodeJS.ReadableStream,
      }
    );
    expect(mode).toBe("agent");
  });

  it("prompts the user on a TTY and returns 'human' when the operator picks that option", async () => {
    const prompt = vi.fn(async () => "human");
    const mode = await resolveLoginMode(
      {},
      {
        stdin: { isTTY: true } as unknown as NodeJS.ReadableStream,
        prompt,
      }
    );
    expect(mode).toBe("human");
    expect(prompt).toHaveBeenCalledTimes(1);
    const [message, choices, defaultValue] = prompt.mock.calls[0];
    expect(typeof message).toBe("string");
    expect(message.length).toBeGreaterThan(0);
    expect(Array.isArray(choices)).toBe(true);
    // The Agent option is the default to keep the unattended-runner
    // UX one keystroke away from the historical behaviour.
    expect(defaultValue).toBe("agent");
    // Both options must be present so the operator can pick either
    // binding without scrolling through unrelated choices.
    const values = (choices as Array<{ value: string }>).map((c) => c.value);
    expect(values).toContain("agent");
    expect(values).toContain("human");
  });

  it("prompts the user on a TTY and returns 'agent' when the operator picks that option", async () => {
    const prompt = vi.fn(async () => "agent");
    const mode = await resolveLoginMode(
      {},
      {
        stdin: { isTTY: true } as unknown as NodeJS.ReadableStream,
        prompt,
      }
    );
    expect(mode).toBe("agent");
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});