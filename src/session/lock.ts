/**
 * Per-conversation mutual exclusion.
 *
 * One Slack conversation owns one Claude session; a second message arriving
 * while Claude is still working must not start a competing turn. `acquire` is
 * a non-blocking try-lock; `waitFor` queues politely until the holder is done.
 */

interface LockEntry {
  locked: boolean;
  waiters: Array<{
    resolve: (acquired: boolean) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }>;
}

export interface AcquireOptions {
  /** Retained for API symmetry; `acquire` never blocks. */
  timeoutMs?: number;
}

export class SessionLock {
  private readonly entries = new Map<string, LockEntry>();

  private entry(key: string): LockEntry {
    let existing = this.entries.get(key);
    if (existing === undefined) {
      existing = { locked: false, waiters: [] };
      this.entries.set(key, existing);
    }
    return existing;
  }

  /** Try to take the lock. Returns false immediately when it is held. */
  acquire(key: string, _options: AcquireOptions = {}): Promise<boolean> {
    const entry = this.entry(key);
    if (entry.locked) return Promise.resolve(false);
    entry.locked = true;
    return Promise.resolve(true);
  }

  /**
   * Wait for the lock, up to `timeoutMs`.
   *
   * Resolves true once taken, false if the timeout fired first or the caller
   * gave up.
   */
  waitFor(key: string, options: AcquireOptions = {}): Promise<boolean> {
    const entry = this.entry(key);
    if (!entry.locked) {
      entry.locked = true;
      return Promise.resolve(true);
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const waiter = {
        resolve: (acquired: boolean): void => {
          if (timer !== null) clearTimeout(timer);
          resolve(acquired);
        },
        timer: null as ReturnType<typeof setTimeout> | null,
      };
      timer = setTimeout(() => {
        const index = entry.waiters.indexOf(waiter);
        if (index >= 0) entry.waiters.splice(index, 1);
        resolve(false);
      }, timeoutMs);
      waiter.timer = timer;
      entry.waiters.push(waiter);
    });
  }

  /** Release the lock, handing it directly to the next waiter if any. */
  release(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    const next = entry.waiters.shift();
    if (next !== undefined) {
      // Ownership transfers; the lock stays held.
      next.resolve(true);
      return;
    }
    entry.locked = false;
  }

  /** True while some conversation turn holds the lock. */
  isBusy(key: string): boolean {
    return this.entries.get(key)?.locked ?? false;
  }

  /** Number of callers queued behind the current holder. */
  waitingCount(key: string): number {
    return this.entries.get(key)?.waiters.length ?? 0;
  }

  /** Drop all lock state — used between tests. */
  clear(): void {
    for (const entry of this.entries.values()) {
      for (const waiter of entry.waiters) waiter.resolve(false);
    }
    this.entries.clear();
  }
}
