import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { astSearch } from "../src/astsearch.js";
import { scan } from "../src/scan.js";

// Real-tool integration test: plants one known defect per engine in a scratch git
// repo and asserts the normalized finding surfaces. Fails on regression in engine
// invocation, JSON parsing, or selection logic.

let repo: string;

const git = (args: string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "opencr-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "base.txt"), "clean\n");
  git(["add", "."]);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
  git(["branch", "base"]);

  // shellcheck: SC2086 unquoted variable
  writeFileSync(join(repo, "bad.sh"), "#!/bin/sh\nf=$1\ncat $f\n");
  // ruff: F821 undefined name
  writeFileSync(join(repo, "bad.py"), "print(undefined_name)\n");
  // gitleaks: fabricated token matching the github-pat pattern (not a real credential;
  // AWS's documented AKIA...EXAMPLE key is on gitleaks' default allowlist, so it
  // cannot serve as the plant)
  writeFileSync(join(repo, "leak.txt"), ["ghp", "_wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx\n"].join(""));
  // actionlint: unknown runner label
  mkdirSync(join(repo, ".github/workflows"), { recursive: true });
  writeFileSync(
    join(repo, ".github/workflows/ci.yml"),
    "on: push\njobs:\n  a:\n    runs-on: no-such-runner\n    steps:\n      - run: echo hi\n",
  );
  git(["add", "."]);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "planted defects"]);
});

describe("scan", () => {
  it("surfaces one normalized finding per planted defect, diff-scoped from base", async () => {
    const result = await scan({ repo, base: "base" });
    const rules = (engine: string) =>
      result.findings.filter((f) => f.engine === engine).map((f) => f.rule);

    expect(rules("shellcheck")).toContain("SC2086");
    expect(rules("ruff")).toContain("F821");
    expect(rules("gitleaks").length).toBeGreaterThan(0);
    expect(rules("actionlint").length).toBeGreaterThan(0);

    const finding = result.findings.find((f) => f.rule === "SC2086");
    expect(finding).toMatchObject({ engine: "shellcheck", file: "bad.sh", line: 3 });
  });

  it("reports not-applicable engines and never fabricates findings for them", async () => {
    const result = await scan({ repo, files: ["base.txt"] });
    for (const r of result.engines) expect(r.status).toBe("not-applicable");
    expect(result.findings).toEqual([]);
  });

  it("engine restriction runs only the named engine", async () => {
    const result = await scan({ repo, base: "base", engines: ["shellcheck"] });
    expect(result.engines.map((r) => r.engine)).toEqual(["shellcheck"]);
    expect(result.findings.every((f) => f.engine === "shellcheck")).toBe(true);
  });
});

describe("ast_search", () => {
  it("matches structurally, 1-based lines", async () => {
    const matches = await astSearch({ repo, pattern: "cat $F", lang: "bash", paths: ["bad.sh"] });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ file: "bad.sh", line: 3 });
  });
});
