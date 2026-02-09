import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { readGameState, type WoWAgentDB } from "./lua-reader.js";
import { findSavedVariablesFile } from "./config.js";

export class FileWatcher extends EventEmitter {
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private filePath: string | null = null;
  private lastData: WoWAgentDB | null = null;
  private lastSyncTime: number = 0;

  constructor(private wtfPath: string) {
    super();
  }

  start(): boolean {
    this.filePath = findSavedVariablesFile(this.wtfPath);

    if (!this.filePath) {
      console.log(
        "[file-watcher] WoWAgent.lua not found. Watching WTF directory for it to appear...",
      );
      this.watchDirectory();
      return false;
    }

    // Read initial state
    this.readFile();

    // Watch the file
    this.watchFile(this.filePath);
    return true;
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  getLastData(): WoWAgentDB | null {
    return this.lastData;
  }

  getLastSyncTime(): number {
    return this.lastSyncTime;
  }

  private watchFile(filePath: string): void {
    try {
      // Watch the directory containing the file (more reliable than watching the file directly)
      const dir = path.dirname(filePath);
      const filename = path.basename(filePath);

      this.watcher = fs.watch(dir, (eventType, changedFile) => {
        if (changedFile === filename) {
          this.debouncedRead();
        }
      });

      this.watcher.on("error", (err) => {
        console.error("[file-watcher] Watch error:", err);
        this.emit("error", err);
      });
    } catch (err) {
      console.error("[file-watcher] Failed to start watching:", err);
      this.emit("error", err);
    }
  }

  private watchDirectory(): void {
    // Watch the WTF path for the SavedVariables file to appear
    try {
      const accountDir = path.join(this.wtfPath, "Account");
      if (!fs.existsSync(accountDir)) return;

      this.watcher = fs.watch(
        accountDir,
        { recursive: true },
        (_eventType, filename) => {
          if (filename && filename.endsWith("WoWAgent.lua")) {
            this.stop();
            this.filePath = findSavedVariablesFile(this.wtfPath);
            if (this.filePath) {
              this.readFile();
              this.watchFile(this.filePath);
            }
          }
        },
      );
    } catch {
      // Directory doesn't exist yet
    }
  }

  private debouncedRead(): void {
    // Debounce: ReloadUI can trigger multiple file writes in quick succession
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.readFile();
    }, 500);
  }

  private readFile(): void {
    if (!this.filePath) return;

    const data = readGameState(this.filePath);
    if (data) {
      this.lastData = data;
      this.lastSyncTime = data.last_sync || Date.now() / 1000;
      this.emit("update", data);
    }
  }
}
