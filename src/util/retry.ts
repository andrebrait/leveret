// Smal retry helper for flaky engine invocations.

export interface RetryOpts {
  attempts: number;
  /** base backoff in ms; doubles each attempt */
  backoffMs: number;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= opts.attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, opts.backoffMs * 2 ** i));
    }
  }
  throw lastErr;
}
