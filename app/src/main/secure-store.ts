import * as fs from "fs";
import * as path from "path";
import { safeStorage } from "electron";
import type {
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import {
  SETTINGS_DIR,
  writePrivateFile,
  readLegacySecrets,
  stripLegacySecrets,
} from "./config.js";

const CREDENTIALS_FILE = path.join(SETTINGS_DIR, "credentials.enc");

type CredentialMap = Record<string, Credential>;

/**
 * Credential store for API keys and OAuth tokens, encrypted at rest with the
 * operating system's user-bound encryption (DPAPI on Windows, Keychain on
 * macOS, the desktop keyring on Linux) through Electron's safeStorage.
 *
 * If OS encryption is unavailable, nothing is written to disk: credentials
 * stay in memory for the session rather than falling back to plain text.
 */
export class SecureCredentialStore implements CredentialStore {
  private cache: CredentialMap = {};
  private encryptionAvailable = false;
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Check OS encryption and load stored credentials. Must run once, after
   * Electron's `ready` event and before the store is used.
   */
  async init(): Promise<void> {
    this.encryptionAvailable = await this.checkEncryption();
    if (!this.encryptionAvailable || !fs.existsSync(CREDENTIALS_FILE)) return;
    try {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(
        fs.readFileSync(CREDENTIALS_FILE),
      );
      const parsed = JSON.parse(result);
      if (parsed && typeof parsed === "object") this.cache = parsed;
      // The OS rotated its key: write the file again under the new one.
      if (shouldReEncrypt) await this.persist();
    } catch (err: any) {
      // Never log the content; the message from safeStorage/JSON carries no secret.
      console.error("[secure-store] Could not read stored credentials:", err?.message);
    }
  }

  private async checkEncryption(): Promise<boolean> {
    try {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
      // On Linux without a keyring Electron falls back to a hardcoded password.
      if (
        process.platform === "linux" &&
        safeStorage.getSelectedStorageBackend() === "basic_text"
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** True when credentials can be persisted encrypted. */
  canPersist(): boolean {
    return this.encryptionAvailable;
  }

  private load(): CredentialMap {
    return this.cache;
  }

  private async persist(): Promise<boolean> {
    if (!this.encryptionAvailable) return false;
    try {
      writePrivateFile(
        CREDENTIALS_FILE,
        await safeStorage.encryptStringAsync(JSON.stringify(this.cache)),
      );
      return true;
    } catch (err: any) {
      console.error("[secure-store] Could not save credentials:", err?.message);
      return false;
    }
  }

  /** Serialize every operation so refresh and login cannot interleave. */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.load()[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.load()).map(([providerId, c]) => ({
      providerId,
      type: c.type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.serialized(async () => {
      const map = this.load();
      const next = await fn(map[providerId]);
      if (next !== undefined) {
        map[providerId] = next;
        await this.persist();
      }
      return map[providerId];
    });
  }

  delete(providerId: string): Promise<void> {
    return this.serialized(async () => {
      const map = this.load();
      if (providerId in map) {
        delete map[providerId];
        await this.persist();
      }
    });
  }

  /**
   * Move plain-text secrets left in settings.json by older versions into this
   * store. The plain-text copy is removed only once the encrypted write
   * succeeded. Must run after `init()`.
   */
  async migrateLegacySecrets(): Promise<void> {
    const legacy = readLegacySecrets();
    if (!legacy) return;

    const credential: Credential | undefined = legacy.oauthCredentials
      ? { ...legacy.oauthCredentials, type: "oauth" }
      : legacy.apiKey
        ? { type: "api_key", key: legacy.apiKey }
        : undefined;
    if (!credential) return;

    await this.serialized(async () => {
      const map = this.load();
      if (!map[legacy.providerId]) map[legacy.providerId] = credential;
      if (await this.persist()) {
        stripLegacySecrets();
        console.log("[secure-store] Moved saved credentials into encrypted storage.");
      } else {
        console.warn(
          "[secure-store] OS encryption unavailable; credentials left in settings.json were loaded for this session but not migrated.",
        );
      }
    });
  }
}
