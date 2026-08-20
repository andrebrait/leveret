import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContract, CONTRACTS } from "../src/prompts.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The contracts are executable instructions for a driving agent. The failure mode
// worth testing is drift: a contract naming a tool the server no longer exposes,
// or the server renaming a tool the contracts still teach.

const serverSource = readFileSync(join(root, "src/server.ts"), "utf8");
const registered = [...serverSource.matchAll(/registerTool\(\s*"([^"]+)"/g)].map((m) => m[1]);

describe("agent contracts", () => {
  it("both contracts exist and load with placeholders substituted", () => {
    for (const name of ["review", "verify"] as const) {
      const text = loadContract(name, { repo: "/tmp/x", base: "origin/main" });
      expect(text).toContain("/tmp/x");
      expect(text).toContain("origin/main");
      expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/); // no unsubstituted placeholders
    }
  });

  it("every MCP tool a contract instructs the agent to call actually exists", () => {
    for (const name of ["review", "verify"] as const) {
      const text = loadContract(name, { repo: "r", base: "b" });
      for (const tool of [...text.matchAll(/`leveret\.([a-z_]+)`/g)].map((m) => m[1])) {
        expect(registered, `${name}.md references unknown tool ${tool}`).toContain(tool);
      }
    }
  });

  it("the review contract mandates the non-negotiables", () => {
    const text = loadContract("review", { repo: "r", base: "b" });
    // cross-file blast radius is the class a diff-only reviewer misses
    expect(text.toLowerCase()).toContain("outside the diff");
    expect(text).toContain("`leveret.scan`");
    expect(text).toContain("`leveret.context`");
    expect(text).toContain("read-only");
  });

  it("the verify contract mandates refute-or-evidence and the three grades", () => {
    const text = loadContract("verify", { repo: "r", base: "b" });
    for (const grade of ["actionable", "priced-noise", "false-positive"]) {
      expect(text).toContain(grade);
    }
    expect(text).toContain("`leveret.remember`");
    expect(text.toLowerCase()).toContain("refute");
  });

  it("CONTRACTS enumerates exactly the shipped contracts", () => {
    expect(Object.keys(CONTRACTS).sort()).toEqual(["review", "verify"]);
  });
});
