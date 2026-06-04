// Warm session pool for the Claude Agent SDK.
//
// The SDK spawns a `claude` CLI subprocess every time `query()` is called —
// adds 1-2s spawn overhead per turn. To match Claude Code CLI's "always warm"
// feel, we keep one Query alive per (taskId, employeeId) and push subsequent
// turns through `streamInput` (the SDK's multi-turn pattern). System prompt,
// tools, cwd are set once on session creation; later turns reuse them.
//
// Constraints:
// - Pool entry busy → caller falls back to a fresh one-shot query (we don't
//   queue concurrently into the same session).
// - Idle timeout closes sessions to free subprocesses.
// - Caller is responsible for invalidating the entry if the run mode changes
//   (e.g. workspace toggled on/off).
import { query, type Query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

class AsyncQueue<T> {
  private items: T[] = [];
  private resolvers: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T) {
    if (this.resolvers.length > 0) this.resolvers.shift()!({ value: item, done: false });
    else this.items.push(item);
  }

  close() {
    this.closed = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()!({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => new Promise<IteratorResult<T>>((resolve) => {
        if (this.items.length > 0) resolve({ value: this.items.shift()!, done: false });
        else if (this.closed) resolve({ value: undefined as never, done: true });
        else this.resolvers.push(resolve);
      }),
    };
  }
}

interface PooledSession {
  q: Query;
  reader: AsyncIterator<unknown>;
  inputQueue: AsyncQueue<SDKUserMessage>;
  /** Signature of the Options used to create this session. If a later turn
   *  needs different tools/cwd/model, we drop and recreate. */
  optionsSig: string;
  lastUsed: number;
  busy: boolean;
}

const sessions = new Map<string, PooledSession>();
const IDLE_MS = 10 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, s] of sessions) {
      if (!s.busy && now - s.lastUsed > IDLE_MS) closeSession(k);
    }
  }, 60_000);
  // Don't keep the Node process alive just for the timer.
  (cleanupTimer as unknown as { unref?: () => void }).unref?.();
}

function closeSession(key: string) {
  const s = sessions.get(key);
  if (!s) return;
  try { s.inputQueue.close(); } catch { /* */ }
  try { s.q.close(); } catch { /* */ }
  sessions.delete(key);
}

export interface UserPrompt {
  text: string;
  /** Optional images to attach as content blocks. Base64 data + media type. */
  images?: Array<{ data: string; mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }>;
}

function makeUserMessage(prompt: string | UserPrompt): SDKUserMessage {
  const isObj = typeof prompt !== "string";
  const text = isObj ? prompt.text : prompt;
  const images = isObj ? (prompt.images ?? []) : [];
  if (images.length === 0) {
    return {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
  }
  // Multimodal: image blocks come BEFORE text per Anthropic guidance (the model
  // attends better when context is established first, then question).
  const content = [
    ...images.map((img) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: img.mediaType, data: img.data },
    })),
    { type: "text" as const, text },
  ];
  return {
    type: "user",
    // Cast: the SDK's MessageParam type accepts content as string or content
    // block array; types may not export the block types broadly enough here.
    message: { role: "user", content } as SDKUserMessage["message"],
    parent_tool_use_id: null,
  };
}

export interface WarmRunHandle {
  /** True if we reused an existing warm subprocess (saves ~1-2s spawn). */
  reused: boolean;
  /** Stream of SDKMessage for this single turn — ends after the result event. */
  events: AsyncGenerator<unknown>;
}

/** Try to reuse a warm session for the given key. Returns null if no entry,
 *  if it's busy, or if the options signature differs (mode changed). Caller
 *  should fall back to a fresh query() and call `register()` to pool it. */
export function reuseSession(key: string, optionsSig: string, prompt: string | UserPrompt): WarmRunHandle | null {
  ensureCleanup();
  const s = sessions.get(key);
  if (!s) return null;
  if (s.busy) return null;
  if (s.optionsSig !== optionsSig) {
    closeSession(key);
    return null;
  }
  s.busy = true;
  s.lastUsed = Date.now();
  s.inputQueue.push(makeUserMessage(prompt));
  return { reused: true, events: drain(s, key) };
}

/** Create a fresh warm session and register it in the pool. The first user
 *  prompt is pushed into the queue before query() starts so the subprocess
 *  has work to do immediately. */
export function createWarmSession(
  key: string,
  optionsSig: string,
  options: Options,
  firstPrompt: string | UserPrompt,
): WarmRunHandle {
  ensureCleanup();
  // If something stale is in the pool (e.g. errored mid-turn), evict.
  if (sessions.has(key)) closeSession(key);

  const inputQueue = new AsyncQueue<SDKUserMessage>();
  inputQueue.push(makeUserMessage(firstPrompt));
  const q = query({ prompt: inputQueue as AsyncIterable<SDKUserMessage>, options });
  const reader = (q as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  const session: PooledSession = {
    q,
    reader,
    inputQueue,
    optionsSig,
    lastUsed: Date.now(),
    busy: true,
  };
  sessions.set(key, session);
  return { reused: false, events: drain(session, key) };
}

async function* drain(s: PooledSession, key: string): AsyncGenerator<unknown> {
  try {
    while (true) {
      const { value: msg, done } = await s.reader.next();
      if (done) {
        // Stream ended (subprocess exit). Drop from pool.
        closeSession(key);
        return;
      }
      yield msg;
      if ((msg as { type?: string }).type === "result") {
        // End of this turn — keep the session in pool for next reuse.
        s.busy = false;
        s.lastUsed = Date.now();
        return;
      }
    }
  } catch (err) {
    // Subprocess crashed or any other error → drop the session so a future
    // turn starts fresh rather than reusing a dead handle.
    closeSession(key);
    throw err;
  }
}

/** Pre-warm: spawn a subprocess and let it sit idle waiting for input. The
 *  next `reuseSession()` for this key picks it up. Use when we know an
 *  employee is about to be chatted with (compose target selected, task
 *  opened) so the spawn cost happens during user think-time. */
export function preWarmSession(key: string, optionsSig: string, options: Options): void {
  ensureCleanup();
  const existing = sessions.get(key);
  if (existing) return; // already warming or in use
  const inputQueue = new AsyncQueue<SDKUserMessage>();
  const q = query({ prompt: inputQueue as AsyncIterable<SDKUserMessage>, options });
  const reader = (q as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  sessions.set(key, {
    q,
    reader,
    inputQueue,
    optionsSig,
    lastUsed: Date.now(),
    busy: false, // ready for first reuseSession to push a prompt
  });
}

/** Drop a specific session — call when task ends or mode changes. */
export function dropSession(key: string) {
  closeSession(key);
}

/** Drop every pooled session whose key references this taskId. Call before
 *  deleting a task's workspace dir on Windows — the SDK subprocess holds the
 *  cwd as an open handle, which makes fs.rmSync throw EBUSY/EPERM and crashes
 *  the DELETE route after the SQLite row was already removed. */
export function dropSessionsByTask(taskId: string): void {
  const needle = `:${taskId}:`;
  for (const key of [...sessions.keys()]) {
    if (key.includes(needle)) closeSession(key);
  }
}
