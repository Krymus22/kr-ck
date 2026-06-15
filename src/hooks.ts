/**
 * hooks.ts — Lifecycle hook system for tool call interception.
 *
 * Plugins and extensions can register callbacks at various lifecycle points:
 *   - preToolCall:   before a tool is executed (can modify args or skip)
 *   - postToolCall:  after a tool completes (can log, modify result, etc.)
 *   - preFileWrite:  before a file is written to disk (can block or modify)
 *   - postFileWrite: after a file is written to disk
 *
 * Hooks execute in registration order. If a preToolCall hook returns
 * `{ skip: true }`, the tool is not executed and the hook's result is
 * returned instead.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HookContext {
  /** Name of the tool being called */
  toolName: string;
  /** Parsed arguments for the tool call */
  args: Record<string, unknown>;
  /** Timestamp of the hook invocation */
  timestamp: number;
}

export interface PreToolCallResult {
  /** If true, skip the tool execution entirely */
  skip?: boolean;
  /** If provided, used as the tool result instead of actual execution */
  resultOverride?: string;
  /** Modified args to pass to the tool (if not skipped) */
  modifiedArgs?: Record<string, unknown>;
}

export interface PostToolCallResult {
  /** Modified result string to return to the model */
  modifiedResult?: string;
}

export interface PreFileWriteResult {
  /** If true, block the file write */
  block?: boolean;
  /** Reason for blocking (shown to user/model) */
  reason?: string;
  /** Modified content to write instead */
  modifiedContent?: string;
}

export type PreToolCallHook = (ctx: HookContext) => PreToolCallResult | Promise<PreToolCallResult>;
export type PostToolCallHook = (ctx: HookContext, result: string) => PostToolCallResult | Promise<PostToolCallResult>;
export type PreFileWriteHook = (filePath: string, content: string) => PreFileWriteResult | Promise<PreFileWriteResult>;
export type PostFileWriteHook = (filePath: string, content: string) => void | Promise<void>;

// ─── Hook Registry ──────────────────────────────────────────────────────────

interface HookEntry<T> {
  id: string;
  handler: T;
  priority: number;
}

class HookRegistry<T extends (...args: any[]) => any> {
  private hooks: HookEntry<T>[] = [];
  private nextId = 0;

  register(handler: T, priority: number = 0): string {
    const id = `hook_${this.nextId++}`;
    this.hooks.push({ id, handler, priority });
    this.hooks.sort((a, b) => a.priority - b.priority);
    return id;
  }

  unregister(id: string): boolean {
    const idx = this.hooks.findIndex((h) => h.id === id);
    if (idx === -1) return false;
    this.hooks.splice(idx, 1);
    return true;
  }

  getAll(): T[] {
    return this.hooks.map((h) => h.handler);
  }

  clear(): void {
    this.hooks = [];
  }
}

// ─── Singleton Registries ───────────────────────────────────────────────────

const preToolCallHooks = new HookRegistry<PreToolCallHook>();
const postToolCallHooks = new HookRegistry<PostToolCallHook>();
const preFileWriteHooks = new HookRegistry<PreFileWriteHook>();
const postFileWriteHooks = new HookRegistry<PostFileWriteHook>();

// ─── Public API ─────────────────────────────────────────────────────────────

/** Register a hook that runs before a tool call. */
export function onPreToolCall(handler: PreToolCallHook, priority?: number): string {
  return preToolCallHooks.register(handler, priority);
}

/** Register a hook that runs after a tool call. */
export function onPostToolCall(handler: PostToolCallHook, priority?: number): string {
  return postToolCallHooks.register(handler, priority);
}

/** Register a hook that runs before a file write. */
export function onPreFileWrite(handler: PreFileWriteHook, priority?: number): string {
  return preFileWriteHooks.register(handler, priority);
}

/** Register a hook that runs after a file write. */
export function onPostFileWrite(handler: PostFileWriteHook, priority?: number): string {
  return postFileWriteHooks.register(handler, priority);
}

/** Unregister a hook by its ID. */
export function unregisterHook(id: string): boolean {
  return (
    preToolCallHooks.unregister(id) ||
    postToolCallHooks.unregister(id) ||
    preFileWriteHooks.unregister(id) ||
    postFileWriteHooks.unregister(id)
  );
}

/** Clear all registered hooks. */
export function clearAllHooks(): void {
  preToolCallHooks.clear();
  postToolCallHooks.clear();
  preFileWriteHooks.clear();
  postFileWriteHooks.clear();
}

// ─── Hook Executors ─────────────────────────────────────────────────────────

/**
 * Execute all preToolCall hooks. Returns the aggregated result.
 * If any hook sets `skip: true`, execution stops and that result is returned.
 */
export async function executePreToolCallHooks(
  toolName: string,
  args: Record<string, unknown>
): Promise<PreToolCallResult> {
  const ctx: HookContext = {
    toolName,
    args: { ...args },
    timestamp: Date.now(),
  };

  let currentArgs = { ...args };
  let skip = false;
  let resultOverride: string | undefined;

  for (const hook of preToolCallHooks.getAll()) {
    const result = await hook({ ...ctx, args: currentArgs });
    if (result.skip) {
      skip = true;
      resultOverride = result.resultOverride;
      break;
    }
    if (result.modifiedArgs) {
      currentArgs = result.modifiedArgs;
    }
  }

  return { skip, resultOverride, modifiedArgs: currentArgs };
}

/**
 * Execute all postToolCall hooks. Returns the aggregated result.
 */
export async function executePostToolCallHooks(
  toolName: string,
  args: Record<string, unknown>,
  result: string
): Promise<PostToolCallResult> {
  const ctx: HookContext = {
    toolName,
    args: { ...args },
    timestamp: Date.now(),
  };

  let currentResult = result;

  for (const hook of postToolCallHooks.getAll()) {
    const hookResult = await hook(ctx, currentResult);
    if (hookResult.modifiedResult) {
      currentResult = hookResult.modifiedResult;
    }
  }

  return { modifiedResult: currentResult };
}

/**
 * Execute all preFileWrite hooks. Returns the aggregated result.
 * If any hook sets `block: true`, the write is prevented.
 */
export async function executePreFileWriteHooks(
  filePath: string,
  content: string
): Promise<PreFileWriteResult> {
  let currentContent = content;
  let block = false;
  let reason: string | undefined;

  for (const hook of preFileWriteHooks.getAll()) {
    const result = await hook(filePath, currentContent);
    if (result.block) {
      block = true;
      reason = result.reason;
      break;
    }
    if (result.modifiedContent) {
      currentContent = result.modifiedContent;
    }
  }

  return { block, reason, modifiedContent: currentContent };
}

/**
 * Execute all postFileWrite hooks.
 */
export async function executePostFileWriteHooks(
  filePath: string,
  content: string
): Promise<void> {
  for (const hook of postFileWriteHooks.getAll()) {
    await hook(filePath, content);
  }
}

// ─── Built-in Hooks ─────────────────────────────────────────────────────────

/**
 * Built-in hook: logs all tool calls to stderr when DEBUG is enabled.
 */
export function registerDebugHook(): string {
  return onPostToolCall(async (ctx, result) => {
    if (process.env.DEBUG === "true") {
      const truncated = result.length > 200 ? result.slice(0, 200) + "..." : result;
      process.stderr.write(`[HOOK:DEBUG] ${ctx.toolName} → ${truncated}\n`);
    }
    return {};
  }, 1000);
}
