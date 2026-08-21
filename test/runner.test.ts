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
