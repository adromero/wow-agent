import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";

// TGA screenshots are ignored: they cannot be previewed or sent to the AI.
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);

export class ScreenshotWatcher extends EventEmitter {
  private watcher: fs.FSWatcher | null = null;
  private parentWatcher: fs.FSWatcher | null = null;
  private seenFiles: Set<string> = new Set();
  private debounceTimer: NodeJS.Timeout | null = null;
  private screenshotsDir: string;

  constructor(private versionFolderPath: string) {
    super();
    this.screenshotsDir = path.join(versionFolderPath, "Screenshots");
  }

  getScreenshotsDir(): string {
    return this.screenshotsDir;
  }

  start(): void {
    if (fs.existsSync(this.screenshotsDir)) {
      this.scanExisting();
      this.watchDirectory();
    } else {
      console.log(
        "[screenshot-watcher] Screenshots dir not found, watching for it to appear...",
      );
      this.watchForDirectoryCreation();
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.parentWatcher) {
      this.parentWatcher.close();
      this.parentWatcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.seenFiles.clear();
  }

  private scanExisting(): void {
    try {
      const files = fs.readdirSync(this.screenshotsDir);
      for (const file of files) {
        if (this.isImageFile(file)) {
          this.seenFiles.add(file);
        }
      }
      console.log(
        `[screenshot-watcher] Tracking ${this.seenFiles.size} existing screenshots`,
      );
    } catch {
      // Directory may have been removed between check and read
    }
  }

  private watchDirectory(): void {
    try {
      // Watch directory for any change, then scan for new files.
      // We intentionally ignore the filename parameter from fs.watch
      // because it can be null or unreliable on macOS.
      this.watcher = fs.watch(this.screenshotsDir, () => {
        this.debouncedScan();
      });

      this.watcher.on("error", (err) => {
        console.error("[screenshot-watcher] Watch error:", err);
      });

      console.log(
        `[screenshot-watcher] Watching: ${this.screenshotsDir}`,
      );
    } catch (err) {
      console.error("[screenshot-watcher] Failed to watch directory:", err);
    }
  }

  private debouncedScan(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.scanForNew();
    }, 500);
  }

  private scanForNew(): void {
    try {
      const files = fs.readdirSync(this.screenshotsDir);
      for (const file of files) {
        if (this.isImageFile(file) && !this.seenFiles.has(file)) {
          this.seenFiles.add(file);
          const filePath = path.join(this.screenshotsDir, file);
          console.log(`[screenshot-watcher] New screenshot: ${file}`);
          this.emit("screenshot", { filePath });
        }
      }
    } catch {
      // Directory may have been removed
    }
  }

  private watchForDirectoryCreation(): void {
    try {
      this.parentWatcher = fs.watch(this.versionFolderPath, () => {
        if (fs.existsSync(this.screenshotsDir)) {
          this.parentWatcher?.close();
          this.parentWatcher = null;
          // Don't scanExisting — these files are new since the directory just appeared
          this.watchDirectory();
          // Scan immediately to pick up the screenshot that triggered directory creation
          this.debouncedScan();
        }
      });
    } catch {
      // Parent directory doesn't exist
    }
  }

  private isImageFile(filename: string): boolean {
    const ext = path.extname(filename).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  }
}
