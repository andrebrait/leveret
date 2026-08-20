import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { context } from "../src/context.js";

// context: prioritization signal for the review agent — complexity, churn, recency.

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
  repo = mkdtempSync(join(tmpdir(), "leveret-ctx-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "m.py"), "def f(a):\n    if a:\n        return 1\n    return 2\n");
  git(["add", "."]);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "one"]);
  writeFileSync(
    join(repo, "m.py"),
    "def f(a):\n    if a:\n        return 1\n    return 2\n\ndef g():\n    return 0\n",
  );
  git(["add", "."]);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "two"]);
});

describe("context", () => {
  it("returns per-function complexity plus churn and recency per file", async () => {
    const result = await context({ repo, files: ["m.py"] });
    expect(result).toHaveLength(1);
    const m = result[0]!;
    expect(m.file).toBe("m.py");
    expect(m.churn).toBe(2);
    expect(m.lastTouched).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const f = m.functions.find((fn) => fn.name === "f");
    expect(f).toMatchObject({ line: 1, endLine: 4, ccn: 2 });
    expect(m.functions.map((fn) => fn.name)).toContain("g");
  });

  it("a file unknown to git still reports functions, with zero churn", async () => {
    writeFileSync(join(repo, "new.py"), "def h():\n    return 3\n");
    const result = await context({ repo, files: ["new.py"] });
    expect(result[0]).toMatchObject({ file: "new.py", churn: 0 });
    expect(result[0]!.functions[0]).toMatchObject({ name: "h", ccn: 1 });
  });
});
