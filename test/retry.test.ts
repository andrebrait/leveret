import { describe, expect, it } from "vitest";
import { withRetry } from "../src/util/retry.js";

// Regression coverage demanded by Leveret's own review of PR #13 (finding R4):
// attempts semantics, no post-failure backoff, hostile inputs, error fidelity.

const failing = (log: number[]) => async () => {
  log.push(Date.now());
  throw new Error(`boom-${log.length}`);
};

describe("withRetry", () => {
  it("attempts means TOTAL invocations, not retries (R2: off-by-one)", async () => {
    const calls: number[] = [];
    await expect(withRetry(failing(calls), { attempts: 3, backoffMs: 1 })).rejects.toThrow("boom-3");
    expect(calls).toHaveLength(3);
  });

  it("backoff is exponential and never runs after the final failure (R3; re-review R2/R4: deterministic via injected sleep)", async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => void delays.push(ms);
    await expect(
      withRetry(failing([]), { attempts: 3, backoffMs: 100, sleep }),
    ).rejects.toThrow("boom-3");
    // exactly TWO backoffs for three attempts (none after the last), doubling
    expect(delays).toEqual([100, 200]);
  });

  it("preserves thrown Errors and wraps non-Error throwables (re-review R3)", async () => {
    const sentinel = new Error("original");
    await expect(
      withRetry(async () => { throw sentinel; }, { attempts: 1, backoffMs: 1 }),
    ).rejects.toBe(sentinel);
    await expect(
      withRetry(async () => { throw "stringy failure"; }, { attempts: 1, backoffMs: 1 }),
    ).rejects.toThrow("stringy failure");
  });

  it("rejects invalid attempt counts loudly instead of throwing undefined or looping forever (R1)", async () => {
    for (const attempts of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      await expect(withRetry(async () => 1, { attempts, backoffMs: 1 })).rejects.toThrow(RangeError);
    }
  });

  it("returns the first success and stops retrying", async () => {
    let n = 0;
    const result = await withRetry(
      async () => {
        n += 1;
        if (n < 2) throw new Error("flaky once");
        return "ok";
      },
      { attempts: 3, backoffMs: 1 },
    );
    expect(result).toBe("ok");
    expect(n).toBe(2);
  });
});
