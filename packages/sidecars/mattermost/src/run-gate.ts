/**
 * A bridge-wide cap on Chi runs that are IN FLIGHT at once.
 *
 * One `RunGate` serves the whole bridge process (every bot shares it). A run holds a slot from just before its
 * `chi_run` / `chi_resume` call until the bridge sees it end (a terminal status), fails to start it, or gives up
 * following it. Since the shell started returning from `chi_run` immediately, counting only the RPC would count nothing.
 *
 * Callers get a `RunSlot` and must give it back; `RunSlot.release()` is idempotent, so a path that releases twice
 * (an early release at the terminal status, then again when the turn is torn down) is harmless, and a path that
 * forgets is covered by the teardown that every call site already has.
 */

export const DEFAULT_MAX_CONCURRENT_RUNS = 4;
export const MIN_CONCURRENT_RUNS = 1;
export const MAX_CONCURRENT_RUNS = 32;

/** The bridge-wide `limits` block. */
export interface RunLimits {
  maxConcurrentRuns: number;
}

const LIMITS_KEYS = new Set(['maxConcurrentRuns']);

/** Validate the top-level `limits` block. Throws, naming the field. Absent = the default. */
export function resolveLimits(raw: unknown): RunLimits {
  if (raw === undefined) return { maxConcurrentRuns: DEFAULT_MAX_CONCURRENT_RUNS };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bridge config: limits must be an object');
  for (const key of Object.keys(raw)) {
    if (!LIMITS_KEYS.has(key)) throw new Error(`bridge config: limits: unknown field '${key}'; allowed: ${[...LIMITS_KEYS].join(', ')}`);
  }
  const v = (raw as { maxConcurrentRuns?: unknown }).maxConcurrentRuns;
  if (v === undefined) return { maxConcurrentRuns: DEFAULT_MAX_CONCURRENT_RUNS };
  if (typeof v !== 'number' || !Number.isInteger(v) || v < MIN_CONCURRENT_RUNS || v > MAX_CONCURRENT_RUNS) {
    throw new Error(
      `bridge config: limits.maxConcurrentRuns must be an integer from ${MIN_CONCURRENT_RUNS} to ${MAX_CONCURRENT_RUNS} (got ${JSON.stringify(v)})`,
    );
  }
  return { maxConcurrentRuns: v };
}

/** The wait for a slot was abandoned (the thread said `stop`, or the bridge is stopping). */
export class RunWaitAbortedError extends Error {
  constructor() {
    super('the run was cancelled while it waited for a free slot');
    this.name = 'RunWaitAbortedError';
  }
}

/** The gate was closed (bridge shutdown); nothing more starts. */
export class RunGateClosedError extends Error {
  constructor() {
    super('the bridge is stopping');
    this.name = 'RunGateClosedError';
  }
}

/** Either of the two ways a wait for a slot ends without a slot. */
export function isGateStop(err: unknown): err is RunWaitAbortedError | RunGateClosedError {
  return err instanceof RunWaitAbortedError || err instanceof RunGateClosedError;
}

/** Who wants a slot. Only ever logged: never message text, prompts or secrets. */
export interface SlotOwner {
  bot: string;
  /** `thread` | `resume` | `act` | `schedule` | `recovered` ... */
  kind: string;
}

export interface QueuedInfo {
  /** Waiters in the queue before this one. */
  ahead: number;
  /** Runs holding a slot right now. */
  inFlight: number;
  max: number;
}

export interface AcquireOptions {
  /** Abort to leave the queue (rejects with `RunWaitAbortedError`). */
  signal?: AbortSignal;
  /** Called synchronously, only when the request has to wait. */
  onQueued?: (info: QueuedInfo) => void;
}

/** One held slot. Only the gate makes these. */
export class RunSlot {
  private done = false;
  /** How long the request waited for this slot, ms (0 when it started at once or the slot was adopted). */
  readonly waitedMs: number;

  constructor(
    private readonly giveBack: () => void,
    waitedMs = 0,
  ) {
    this.waitedMs = waitedMs;
  }

  get released(): boolean {
    return this.done;
  }

  /** Give the slot back. Safe to call any number of times; only the first does anything. */
  release(): void {
    if (this.done) return;
    this.done = true;
    this.giveBack();
  }
}

interface Waiter {
  owner: SlotOwner;
  queuedAt: number;
  resolve: (slot: RunSlot) => void;
  reject: (err: unknown) => void;
  cleanup: () => void;
}

export interface RunGateOptions {
  max: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export class RunGate {
  private held = 0;
  private closed = false;
  private readonly queue: Waiter[] = [];
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  readonly max: number;

  constructor(opts: RunGateOptions) {
    if (!Number.isInteger(opts.max) || opts.max < MIN_CONCURRENT_RUNS) throw new Error(`RunGate: max must be an integer >= ${MIN_CONCURRENT_RUNS}`);
    this.max = opts.max;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(`[mattermost:run-gate] ${m}`));
  }

  /** Runs holding a slot (including adopted ones). */
  get inFlight(): number {
    return this.held;
  }

  /** Requests waiting for a slot. */
  get queued(): number {
    return this.queue.length;
  }

  /**
   * Wait (FIFO, no polling) for a slot. Resolves at once when one is free and nobody is queued ahead.
   * Rejects with `RunWaitAbortedError` when `signal` aborts first, `RunGateClosedError` after `close()`.
   */
  acquire(owner: SlotOwner, opts: AcquireOptions = {}): Promise<RunSlot> {
    if (this.closed) return Promise.reject(new RunGateClosedError());
    if (opts.signal?.aborted) return Promise.reject(new RunWaitAbortedError());
    if (this.held < this.max && this.queue.length === 0) {
      this.held += 1;
      return Promise.resolve(this.makeSlot(0));
    }
    return new Promise<RunSlot>((resolve, reject) => {
      const waiter: Waiter = { owner, queuedAt: this.now(), resolve, reject, cleanup: () => undefined };
      const onAbort = () => {
        const i = this.queue.indexOf(waiter);
        if (i < 0) return; // already granted
        this.queue.splice(i, 1);
        waiter.cleanup();
        this.log(`queued run left the queue: bot=${owner.bot} kind=${owner.kind} depth=${this.queue.length}`);
        reject(new RunWaitAbortedError());
      };
      if (opts.signal) {
        opts.signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = () => opts.signal?.removeEventListener('abort', onAbort);
      }
      const ahead = this.queue.length;
      this.queue.push(waiter);
      this.log(`run queued: bot=${owner.bot} kind=${owner.kind} ahead=${ahead} depth=${this.queue.length} inFlight=${this.held}/${this.max}`);
      opts.onQueued?.({ ahead, inFlight: this.held, max: this.max });
    });
  }

  /**
   * Take a slot for a run that is ALREADY going (a restart found it still active). Never waits and never refuses, so
   * the count can sit above `max` until enough of them end; new requests then queue behind it.
   */
  adopt(owner: SlotOwner): RunSlot {
    this.held += 1;
    this.log(`run adopted: bot=${owner.bot} kind=${owner.kind} inFlight=${this.held}/${this.max}`);
    return this.makeSlot(0);
  }

  /** Refuse further requests and reject everyone waiting. Slots already held stay valid (and releasable). */
  close(): void {
    this.closed = true;
    for (const w of this.queue.splice(0)) {
      w.cleanup();
      w.reject(new RunGateClosedError());
    }
  }

  private makeSlot(waitedMs: number): RunSlot {
    return new RunSlot(() => {
      this.held -= 1;
      this.drain();
    }, waitedMs);
  }

  private drain(): void {
    while (this.held < this.max && this.queue.length > 0) {
      const w = this.queue.shift() as Waiter;
      w.cleanup();
      this.held += 1;
      const waited = Math.max(0, this.now() - w.queuedAt);
      this.log(
        `run started after waiting ${Math.round(waited / 1000)}s: bot=${w.owner.bot} kind=${w.owner.kind} depth=${this.queue.length} inFlight=${this.held}/${this.max}`,
      );
      w.resolve(this.makeSlot(waited));
    }
  }
}
