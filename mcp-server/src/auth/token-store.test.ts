import { describe, it, expect } from "vitest";
import { InMemorySecretProvider } from "./token-store.js";

describe("InMemorySecretProvider", () => {
  it("stores and returns credentials", () => {
    const store = new InMemorySecretProvider();
    expect(store.read()).toBeNull();
    store.write({ apiUrl: "https://x", clientId: "cid" });
    expect(store.read()).toEqual({ apiUrl: "https://x", clientId: "cid" });
  });

  it("clears stored credentials", () => {
    const store = new InMemorySecretProvider();
    store.write({ apiUrl: "https://x", clientId: "cid" });
    store.clear();
    expect(store.read()).toBeNull();
  });
});