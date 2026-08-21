import { describe, expect, it } from "vitest";
import { buildOmpArgs, parseOmpEvents, PURITY_FLAGS } from "../src/runner/omp.js";

// leveret-runner-omp: the standardized App runner. Pure parts under test —
// argument assembly (caller params, precedence, fixed purity) and event-stream
// parsing (final JSON extraction).

describe("buildOmpArgs", () => {
  it("defaults: Sol at thinking high, purity flags always present", () => {
    const args = buildOmpArgs({}, {});
    expect(args).toContain("--model=gpt-5.6-sol");
    expect(args).toContain("--thinking=high");
    for (const f of PURITY_FLAGS) expect(args).toContain(f);
  });

  it("caller params flow: provider, model, effort, max-time, passthrough", () => {
    const args = buildOmpArgs(
      { model: "opus", effort: "medium", provider: "anthropic", maxTime: "20m", ompArgs: ["--profile=work"] },
      {},
    );
    expect(args).toContain("--model=opus");
    expect(args).toContain("--thinking=medium");
    expect(args).toContain("--provider=anthropic");
    expect(args).toContain("--max-time=20m");
    expect(args).toContain("--profile=work");
  });

  it("CLI beats env beats defaults", () => {
    const env = { LEVERET_RUNNER_MODEL: "envmodel", LEVERET_RUNNER_EFFORT: "low" };
    expect(buildOmpArgs({}, env)).toContain("--model=envmodel");
    expect(buildOmpArgs({ model: "climodel" }, env)).toContain("--model=climodel");
    expect(buildOmpArgs({ model: "climodel" }, env)).toContain("--thinking=low");
  });

  it("purity flags cannot be overridden away", () => {
    const args = buildOmpArgs({ ompArgs: ["--skills=git-*", "--lsp"] }, {});
    for (const f of PURITY_FLAGS) expect(args).toContain(f);
    // the hostile passthroughs are dropped, not appended after the purity flags
    expect(args).not.toContain("--skills=git-*");
    expect(args).not.toContain("--lsp");
  });
});

describe("parseOmpEvents", () => {
  const lines = [
    '{"type":"session","id":"s1"}',
    '{"type":"tool_execution_start","toolName":"write","args":{"path":"xd://mcp__leveret_scan"}}',
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"thinking aloud, not JSON"}]}}',
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"concerns\\":[],\\"coverage\\":{\\"lenses\\":[],\\"files\\":[]}}"}]}}',
  ].join("\n");

  it("returns the LAST assistant message that parses as JSON, plus tool tallies", () => {
    const r = parseOmpEvents(lines);
    expect(r.json).toEqual({ concerns: [], coverage: { lenses: [], files: [] } });
    expect(r.toolCalls.write).toBe(1);
    expect(r.mcpCalls).toContain("mcp__leveret_scan");
  });

  it("throws with the raw tail when no assistant JSON exists", () => {
    expect(() => parseOmpEvents('{"type":"session"}')).toThrow(/no JSON/i);
  });
});

describe("run() timeout (stuck-tool cap)", () => {
  it("kills a wedged child and reports the signal instead of waiting forever", async () => {
    const { run } = await import("../src/exec.js");
    const t0 = Date.now();
    const r = await run("sleep", ["30"], "/tmp", { timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.code).not.toBe(0);
    expect(r.signal).toBeTruthy();
  });
});

describe("buildMcpConfig", () => {
  it("wires the leveret MCP server and codegraph for the reviewed checkout", async () => {
    const { buildMcpConfig } = await import("../src/runner/omp.js");
    const cfg = buildMcpConfig("/opt/leveret/dist/runner/omp.js", true);
    expect(cfg.mcpServers.leveret.command).toBe("node");
    expect(cfg.mcpServers.leveret.args).toEqual(["/opt/leveret/dist/server.js"]);
    expect(cfg.mcpServers.codegraph).toEqual({ command: "codegraph", args: ["serve", "--mcp"] });
    const noGraph = buildMcpConfig("/opt/leveret/dist/runner/omp.js", false);
    expect(noGraph.mcpServers.codegraph).toBeUndefined();
  });
});

describe("parseDuration", () => {
  it("understands omp-style durations and adds the slack for the outer cap", async () => {
    const { parseDuration } = await import("../src/runner/omp.js");
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("90")).toBe(90_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("bogus")).toBeNull();
  });
});

describe("spawnCapture (the phase executor)", () => {
  it("ignores stdin so EOF-waiting CLIs finish instead of wedging", async () => {
    const { spawnCapture } = await import("../src/runner/omp.js");
    // cat hangs forever on an open stdin pipe; with stdin ignored it exits at once
    const t0 = Date.now();
    const r = await spawnCapture("cat", [], "/tmp", 5000);
    expect(r.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("kills at the deadline and marks the result timed out", async () => {
    const { spawnCapture } = await import("../src/runner/omp.js");
    const r = await spawnCapture("sleep", ["30"], "/tmp", 300);
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
  });
});

describe("phase retry on crash", () => {
  it("a crashing command is retried once; a second crash surfaces", async () => {
    const { runPhaseCommand } = await import("../src/runner/omp.js");
    const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const d = mkdtempSync(join(tmpdir(), "lev-retry-"));
    // crashes on first run, succeeds on second (state via marker file)
    writeFileSync(join(d, "fickle.sh"), '#!/bin/sh\nif [ -f flag ]; then echo \'{"ok":true}\'; else touch flag; echo boom >&2; exit 1; fi\n');
    chmodSync(join(d, "fickle.sh"), 0o755);
    const r = await runPhaseCommand("./fickle.sh", [], d, 5000);
    expect(r.stdout).toContain('"ok":true');
    // always-crashing command: two attempts then loud failure
    writeFileSync(join(d, "dead.sh"), "#!/bin/sh\nexit 7\n");
    chmodSync(join(d, "dead.sh"), 0o755);
    await expect(runPhaseCommand("./dead.sh", [], d, 5000)).rejects.toThrow(/rc=7/);
  });

  it("a deadline kill is NOT retried", async () => {
    const { runPhaseCommand } = await import("../src/runner/omp.js");
    const t0 = Date.now();
    await expect(runPhaseCommand("sleep", ["30"], "/tmp", 400)).rejects.toThrow(/deadline/);
    expect(Date.now() - t0).toBeLessThan(5000); // one attempt, not two
  });
});

describe("verify-output schema enforcement", () => {
  it("names every missing required section, including resolutions when prior findings were supplied", async () => {
    const { verifySchemaGaps } = await import("../src/runner/omp.js");
    const bare = { report: [] };
    expect(verifySchemaGaps(bare, false)).toEqual(["verdicts", "coverage"]);
    const full = {
      report: [],
      verdicts: [],
      coverage: { lenses: [{ lens: "x", outcome: "clean" }], files: [{ file: "a", verdict: "considered-fine" }] },
    };
    expect(verifySchemaGaps(full, false)).toEqual([]);
    // prior findings supplied -> resolutions become required
    expect(verifySchemaGaps(full, true)).toEqual(["resolutions"]);
    // empty coverage arrays count as missing: an empty table is silent shrinkage
    expect(verifySchemaGaps({ report: [], verdicts: [], coverage: { lenses: [], files: [] } }, false)).toEqual(["coverage"]);
  });
});
