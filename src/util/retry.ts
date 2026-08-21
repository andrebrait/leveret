// Small retry helper for genuinely nondeterministic I/O — network fetches like
// semgrep's registry rulesets, or an external model crashing mid-stream. It is
// NOT a blanket for engine bugs: a deterministic tool that fails deserves a fix,
// not a retry.

export interface RetryOpts {
  /** TOTAL invocations, including the first (must be a positive integer) */
  attempts: number;
  /** base backoff in ms; doubles between attempts, never sleeps after the last */
  backoffMs: number;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {
  if (!Number.isInteger(opts.attempts) || opts.attempts < 1) {
    throw new RangeError(`attempts must be a positive integer, got ${opts.attempts}`);
  }
  let lastErr: unknown;
  for (let i = 0; i < opts.attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < opts.attempts - 1) {
        await new Promise((r) => setTimeout(r, opts.backoffMs * 2 ** i));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
