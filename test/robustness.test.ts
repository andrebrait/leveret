import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { context } from "../src/context.js";
import { run, scratchPath } from "../src/exec.js";
import { scan } from "../src/scan.js";

// exec-robustness bucket from the self-review: signal deaths, tmp collisions,
// fail-open engines, and silent tool absence.

describe("run() (R6)", () => {
  it("a signal-killed child is a failure, not exit 0 with partial output", async () => {
    const r = await run("sh", ["-c", "echo partial; kill -TERM $$"], "/tmp");
    expect(r.code).not.toBe(0);
    expect(r.signal).toBe("SIGTERM");
  });
});

describe("scratchPath (R7)", () => {
  it("two calls never collide, even within one process", () => {
    const a = scratchPath("leveret-x");
    const b = scratchPath("leveret-x");
    expect(a).not.toBe(b);
    // pid alone is NOT unique across concurrent calls in the long-lived MCP server
    expect(a).not.toBe(join(tmpdir(), `leveret-x-${process.pid}`));
  });
});

describe("typos engine failure (R10)", () => {
  it("a crashed typos run surfaces as engine error, never clean", async () => {
    const repo = mkdtempSync(join(tmpdir(), "lev-typosfail-"));
    writeFileSync(join(repo, "doc.md"), "Teh accomodate typo\n");
    writeFileSync(join(repo, "_typos.toml"), "[default\nbroken = \n");
    const r = await scan({ repo, files: ["doc.md"], engines: ["typos"] });
    expect(r.engines[0]!.status).toBe("error");
    expect(r.engines[0]!.detail).toBeTruthy();
  });
});

describe("context tool absence (R14)", () => {
  const oldPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = oldPath;
  });

  it("missing lizard is surfaced, not reported as zero-complexity code", async () => {
    const repo = mkdtempSync(join(tmpdir(), "lev-ctxfail-"));
    writeFileSync(join(repo, "m.py"), "def f():\n    return 1\n");
    process.env.PATH = "/usr/bin:/bin"; // lizard lives in ~/.local/bin
    const result = await context({ repo, files: ["m.py"] });
    expect(result[0]!.functions).toBeNull();
    expect(result[0]!.error).toMatch(/lizard/);
  });
});
