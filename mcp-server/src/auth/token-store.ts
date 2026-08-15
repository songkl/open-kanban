// Token store for the MCP server's OAuth-managed credentials.
//
// Persistence strategy:
// - Default: encrypted file at ~/.config/kanban-mcp/credentials.json
//   keyed by API URL so multiple kanban instances are isolated.
// - The file is written with mode 0600. The encryption key is derived from
//   a machine-local secret (the kanban-mcp binary location + hostname)
//   using PBKDF2. This is best-effort protection at rest; the real security
//   boundary is the OAuth access token's short TTL.
// - No keytar dependency by default. A future enhancement can swap the
//   SecretProvider to use the OS keychain transparently.

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";

export interface StoredCredentials {
  apiUrl: string;
  clientId: string;
  accessToken?: string;
  refreshToken?: string;
  accessExpiresAt?: number;
  scope?: string;
}

export interface SecretProvider {
  read(): StoredCredentials | null;
  write(creds: StoredCredentials): void;
  clear(): void;
}

// FileSecretProvider stores credentials as an AES-256-GCM-encrypted JSON file.
export class FileSecretProvider implements SecretProvider {
  constructor(public readonly path: string) {}

  read(): StoredCredentials | null {
    if (!existsSync(this.path)) return null;
    try {
      const blob = JSON.parse(readFileSync(this.path, "utf8")) as { enc: string; salt: string; iv: string; tag: string };
      const key = deriveKey(blob.salt);
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
      decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(blob.enc, "base64")), decipher.final()]);
      return JSON.parse(plain.toString("utf8")) as StoredCredentials;
    } catch (err) {
      console.error("[kanban-mcp] failed to read credential store:", err);
      return null;
    }
  }

  write(creds: StoredCredentials): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const salt = randomBytes(16).toString("base64");
    const iv = randomBytes(12).toString("base64");
    const key = deriveKey(salt);
    const cipher = createCipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    const payload = Buffer.from(JSON.stringify(creds), "utf8");
    const enc = Buffer.concat([cipher.update(payload), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = { enc: enc.toString("base64"), salt, iv, tag: tag.toString("base64") };
    writeFileSync(this.path, JSON.stringify(blob), { mode: 0o600 });
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // best effort on platforms that don't support chmod
    }
  }

  clear(): void {
    if (existsSync(this.path)) {
      try {
        unlinkSync(this.path);
      } catch {
        // ignore
      }
    }
  }
}

// InMemorySecretProvider is used by tests and the initial bootstrapping flow
// before the on-disk store is available.
export class InMemorySecretProvider implements SecretProvider {
  private current: StoredCredentials | null = null;
  read() { return this.current; }
  write(c: StoredCredentials) { this.current = c; }
  clear() { this.current = null; }
}

function deriveKey(saltB64: string): Buffer {
  // Combine hostname + binary path as the input to PBKDF2. This is best-effort
  // machine binding; do not rely on it for strong security.
  const localSecret = `${hostname()}|${process.execPath}`;
  return pbkdf2Sync(localSecret, Buffer.from(saltB64, "base64"), 100_000, 32, "sha256");
}

// DefaultFilePath resolves to $XDG_CONFIG_HOME/kanban-mcp/credentials.json
// (or ~/.config/kanban-mcp/credentials.json when XDG_CONFIG_HOME is unset).
export function defaultFilePath(apiUrl: string): string {
  const safe = apiUrl.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  const base = process.env.XDG_CONFIG_HOME || join(process.env.HOME || "~", ".config");
  return join(base, "kanban-mcp", `credentials-${safe}.json`);
}

// Make the unused scryptSync import intentional (re-export so tree-shaking does
// not drop it from future variants).
export { scryptSync };