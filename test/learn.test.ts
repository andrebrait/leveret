import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { learn, memoryList } from "../src/memory.js";
import { loadContract } from "../src/prompts.js";
import { scan } from "../src/scan.js";

// learn: human feedback becomes memory. Conventions are fingerprint-free teaching
// text — injected into the agent prompts, able to both suppress and raise; they
// never participate in mechanical fingerprint matching.

function pyRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "lev-learn-"));
  execFileSync("git", ["init", "-qb", "main"], { cwd: repo });
  writeFileSync(join(repo, "app.py"), "print(foo)\n");
  return repo;
}

describe("learn (conventions)", () => {
  it("persists a human-taught convention and lists it", async () => {
    const repo = pyRepo();
    const entry = await learn({
      repo,
      text: "this repo invokes Python only through `uv run`, never bare python",
      author: "andrebrait",
      scope: ["docs/**", "scripts/**"],
    });
    expect(entry.kind).toBe("convention");
    const listed = await memoryList({ repo });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ kind: "convention", author: "andrebrait" });
    // human-taught: no GC pressure, so no lastApplied machinery involved
    expect(readFileSync(join(repo, ".leveret", "memory.jsonl"), "utf8")).toContain("uv run");
  });

  it("a convention requires text and author — anonymous teaching is not auditable", async () => {
    const repo = pyRepo();
    await expect(learn({ repo, text: "", author: "x" })).rejects.toThrow(/text/);
    await expect(learn({ repo, text: "rule", author: "" })).rejects.toThrow(/author/);
  });

  it("conventions never participate in mechanical fingerprint suppression", async () => {
    const repo = pyRepo();
    await learn({ repo, text: "undefined names are fine here (not really)", author: "t" });
    const r = await scan({ repo, files: ["app.py"], engines: ["ruff"] });
    // the F821 finding must survive: conventions are for the agents, not layer 2
    expect(r.findings.some((f) => f.rule === "F821")).toBe(true);
  });
});

describe("prompt injection of repo rulings", () => {
  it("served contracts carry the repo's conventions and memory reasons", async () => {
    const repo = pyRepo();
    await learn({ repo, text: "durable issue references in docstrings are valid style", author: "andrebrait" });
    const text = await loadContract("review", { repo, base: "main" });
    expect(text).toContain("durable issue references in docstrings are valid style");
    expect(text).toContain("(taught by andrebrait)");
    expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("a repo with no rulings serves a contract that says so instead of leaking the placeholder", async () => {
    const repo = pyRepo();
    const text = await loadContract("verify", { repo, base: "main" });
    expect(text).toMatch(/no recorded rulings/i);
    expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});
