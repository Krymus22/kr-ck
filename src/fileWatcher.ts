/**
 * fileWatcher.ts - File watcher that reacts to file changes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as log from "./logger.js";

export type FileChangeType = "created" | "modified" | "deleted" | "renamed";

export interface FileChangeEvent {
  type: FileChangeType;
  filePath: string;
  oldPath?: string;
  timestamp: Date;
}

export type FileWatcherCallback = (event: FileChangeEvent) => void;

export class FileWatcher {
  private readonly watchers: Map<string, fs.FSWatcher> = new Map();
  private readonly callbacks: Set<FileWatcherCallback> = new Set();
  private readonly watchedPaths: Set<string> = new Set();
  private pollInterval: NodeJS.Timeout | null = null;
  private readonly fileSnapshots: Map<string, number> = new Map(); // path -> mtimeMs

  addCallback(cb: FileWatcherCallback): void {
    this.callbacks.add(cb);
  }

  removeCallback(cb: FileWatcherCallback): void {
    this.callbacks.delete(cb);
  }

  watch(dirOrFile: string, recursive: boolean = false): void {
    const resolved = path.resolve(dirOrFile);
    if (this.watchedPaths.has(resolved)) return;

    try {
      if (fs.existsSync(resolved)) {
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
          this.watchDirectory(resolved, recursive);
        } else {
          this.watchFile(resolved);
        }
        this.watchedPaths.add(resolved);
        log.debug(`Watching: ${resolved}`);
      }
    } catch (err) {
      log.error(`Failed to watch ${resolved}: ${(err as Error).message}`);
    }
  }

  unwatch(dirOrFile: string): void {
    const resolved = path.resolve(dirOrFile);
    const watcher = this.watchers.get(resolved);
    if (watcher) {
      watcher.close();
      this.watchers.delete(resolved);
    }
    this.watchedPaths.delete(resolved);
  }

  private watchFile(filePath: string): void {
    try {
      const watcher = fs.watch(filePath, (eventType) => {
        const changeType: FileChangeType = eventType === "rename" ? "deleted" : "modified";
        this.emit({ type: changeType, filePath, timestamp: new Date() });
      });
      this.watchers.set(filePath, watcher);
    } catch {
      // fallback to polling
    }
  }

  private watchDirectory(dirPath: string, recursive: boolean): void {
    try {
      const watcher = fs.watch(dirPath, { recursive }, (eventType, filename) => {
        if (!filename) return;
        const fullPath = path.join(dirPath, filename);
        // BUG FIX (Bug Hunter #7): previously any "rename" event was
        // classified as "created". But "rename" in fs.watch fires for
        // creation, deletion, AND renames inside the directory. Always
        // emitting "created" meant a deleted file was reported as created,
        // confusing watchers (and the agent) into thinking a non-existent
        // file was just added.
        //
        // Fix: stat the path after the event. If it exists now, it was
        // created (or renamed-to). If it doesn't, it was deleted (or
        // renamed-away). "change" events stay as "modified".
        let changeType: FileChangeType;
        if (eventType === "rename") {
          changeType = fs.existsSync(fullPath) ? "created" : "deleted";
        } else {
          changeType = "modified";
        }
        this.emit({ type: changeType, filePath: fullPath, timestamp: new Date() });
      });
      this.watchers.set(dirPath, watcher);
    } catch {
      // fallback to polling
    }
  }

  startPolling(intervalMs: number = 1000): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(() => {
      this.checkForChanges();
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private checkForChanges(): void {
    for (const watchPath of this.watchedPaths) {
      try {
        if (!fs.existsSync(watchPath)) {
          if (this.fileSnapshots.has(watchPath)) {
            this.emit({ type: "deleted", filePath: watchPath, timestamp: new Date() });
            this.fileSnapshots.delete(watchPath);
          }
          continue;
        }

        const stat = fs.statSync(watchPath);
        const currentMtime = stat.mtimeMs;
        const prevMtime = this.fileSnapshots.get(watchPath);

        if (prevMtime !== undefined && currentMtime !== prevMtime) {
          this.emit({ type: "modified", filePath: watchPath, timestamp: new Date() });
        } else if (prevMtime === undefined) {
          this.emit({ type: "created", filePath: watchPath, timestamp: new Date() });
        }

        this.fileSnapshots.set(watchPath, currentMtime);
      } catch {
        // skip errors
      }
    }
  }

  private emit(event: FileChangeEvent): void {
    // BUG FIX (concurrency race — mirrors Bug Hunter #8c fix in activityTracker):
    // previously iterated `this.callbacks` Set directly. If a callback called
    // `addCallback()` or `removeCallback()` (common pattern for one-shot
    // listeners that remove themselves after firing), the Set was mutated
    // mid-iteration — leading to non-deterministic behavior (a newly-added
    // callback might be called or skipped depending on V8's Set iteration
    // order, and a just-removed callback might still be called once).
    // Snapshot the callbacks into an array so notification is stable
    // regardless of any add/remove that happens inside a callback.
    const snapshot = Array.from(this.callbacks);
    for (const cb of snapshot) {
      try {
        cb(event);
      } catch (err) {
        log.error(`FileWatcher callback error: ${(err as Error).message}`);
      }
    }
  }

  close(): void {
    this.stopPolling();
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    this.watchedPaths.clear();
    this.fileSnapshots.clear();
    // MEMORY FIX (Round 4 — memory + perf): previously `callbacks` was NOT
    // cleared here. If a caller registered a callback that captured a large
    // object (closure over project state, file contents, etc.) and then
    // called `close()` to tear down the watcher, the callback stayed in the
    // Set forever — the captured closure could not be GC'd. The singleton
    // `globalWatcher` (from `getFileWatcher()`) lives for the whole process,
    // so this leak accumulated across `close()`/re-`watch()` cycles. Clear
    // callbacks so callers don't have to remember to `removeCallback()`
    // every single listener before tearing down.
    this.callbacks.clear();
  }
}

let globalWatcher: FileWatcher | null = null;

export function getFileWatcher(): FileWatcher {
  globalWatcher ??= new FileWatcher();
  return globalWatcher;
}
