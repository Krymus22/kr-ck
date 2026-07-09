/**
 * backgroundProcesses.ts — Registry for background processes spawned by
 * executar_comando with { background: true }.
 *
 * Allows the IA to start long-running commands (rojo serve, npm run dev,
 * tsc --watch, etc) without blocking the agent loop. The process runs
 * in the background, stdout/stderr are buffered, and the IA can check
 * the output later via verificar_comando.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as log from "./logger.js";

export interface BackgroundProcess {
  id: number;
  pid: number;
  command: string;
  process: ChildProcess;
  stdout: string;
  stderr: string;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
  /** Max buffer size per stream (default 256KB) */
  maxBuffer: number;
}

const MAX_PROCESSES = 10;
const MAX_BUFFER = 256 * 1024; // 256KB per stream

let nextId = 1;
const processes = new Map<number, BackgroundProcess>();

/**
 * Start a command in the background. Returns immediately with the process ID.
 * The command's stdout/stderr are captured into buffers (up to MAX_BUFFER each).
 */
export function startBackgroundProcess(
  command: string,
  cwd?: string,
): BackgroundProcess {
  if (processes.size >= MAX_PROCESSES) {
    // Kill the oldest process to make room
    const oldest = [...processes.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
    if (oldest) {
      killProcess(oldest.id);
    }
  }

  const id = nextId++;
  log.info(`[BG_PROC] Starting #${id}: "${command}" (cwd=${cwd ?? process.cwd()})`);

  const child = spawn(command, {
    cwd: cwd ?? process.cwd(),
    shell: process.platform === "win32" ? "powershell.exe" : "/bin/bash",
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  const bgProc: BackgroundProcess = {
    id,
    pid: child.pid ?? -1,
    command,
    process: child,
    stdout: "",
    stderr: "",
    startedAt: Date.now(),
    exited: false,
    exitCode: null,
    maxBuffer: MAX_BUFFER,
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    if (bgProc.stdout.length < bgProc.maxBuffer) {
      bgProc.stdout += chunk.toString("utf8").slice(0, bgProc.maxBuffer - bgProc.stdout.length);
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    if (bgProc.stderr.length < bgProc.maxBuffer) {
      bgProc.stderr += chunk.toString("utf8").slice(0, bgProc.maxBuffer - bgProc.stderr.length);
    }
  });

  child.on("close", (code) => {
    bgProc.exited = true;
    bgProc.exitCode = code;
    log.info(`[BG_PROC] #${id} exited with code ${code}`);
  });

  child.on("error", (err) => {
    bgProc.exited = true;
    bgProc.exitCode = -1;
    bgProc.stderr += `\n[PROCESS ERROR] ${err.message}`;
    log.error(`[BG_PROC] #${id} error: ${err.message}`);
  });

  // Don't let the child keep the process alive
  child.unref();

  processes.set(id, bgProc);
  return bgProc;
}

/**
 * Get the current output (stdout + stderr) of a background process.
 * Returns the accumulated output since the process started.
 * Does NOT clear the buffer — subsequent calls return the full accumulated output.
 */
export function getProcessOutput(id: number): string | null {
  const proc = processes.get(id);
  if (!proc) return null;

  const combined = [proc.stdout, proc.stderr].filter(Boolean).join("\n").trim();
  const status = proc.exited
    ? `[Process exited with code ${proc.exitCode}]`
    : `[Process still running — PID ${proc.pid}]`;

  return `${status}\n${combined || "(no output yet)"}`;
}

/**
 * Get a summary of all background processes.
 */
export function listBackgroundProcesses(): string {
  if (processes.size === 0) {
    return "No background processes running.";
  }

  const lines: string[] = [`Background processes (${processes.size}):`];
  for (const proc of processes.values()) {
    const elapsed = Math.floor((Date.now() - proc.startedAt) / 1000);
    const status = proc.exited ? `exited(${proc.exitCode})` : `running(PID ${proc.pid})`;
    const outLen = proc.stdout.length + proc.stderr.length;
    lines.push(`  #${proc.id}: ${status} ${elapsed}s ${outLen}B — ${proc.command.slice(0, 60)}`);
  }
  return lines.join("\n");
}

/**
 * Kill a background process by ID. Returns true if killed, false if not found
 * or already exited.
 */
export function killProcess(id: number): boolean {
  const proc = processes.get(id);
  if (!proc) return false;
  if (proc.exited) {
    processes.delete(id);
    return false;
  }
  try {
    proc.process.kill("SIGTERM");
    // Give it 2 seconds to exit gracefully, then SIGKILL
    setTimeout(() => {
      if (!proc.exited) {
        try { proc.process.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }, 2000);
  } catch {
    // Process may have already exited
  }
  log.info(`[BG_PROC] #${id} killed`);
  return true;
}

/**
 * Kill ALL background processes. Called on shutdown / /reset.
 */
export function killAllBackgroundProcesses(): void {
  for (const id of [...processes.keys()]) {
    killProcess(id);
    processes.delete(id);
  }
}

/**
 * Clean up exited processes from the registry.
 */
export function cleanupExitedProcesses(): void {
  for (const [id, proc] of processes) {
    if (proc.exited) {
      processes.delete(id);
    }
  }
}

// --- Test helpers -----------------------------------------------------------

export function _getProcessCount(): number {
  return processes.size;
}

export function _resetForTests(): void {
  killAllBackgroundProcesses();
  processes.clear();
  nextId = 1;
}
