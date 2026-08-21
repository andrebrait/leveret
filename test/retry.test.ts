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

  it("does not sleep after the final failure (R3)", async () => {
    const calls: number[] = [];
    const t0 = Date.now();
    await expect(withRetry(failing(calls), { attempts: 2, backoffMs: 200 })).rejects.toThrow();
    // one inter-attempt backoff (200ms), NO trailing 400ms sleep
    expect(Date.now() - t0).toBeLessThan(390);
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
