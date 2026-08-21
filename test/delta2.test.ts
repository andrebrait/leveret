import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSarif } from "../src/sarif.js";
import { scan } from "../src/scan.js";

// Delta-correctness fixes from the self-review round: duplicate-line multiplicity
// (R4), rename tracking (R5), rule packs resolving against the head tree (R3),
// surfaced base-pass failures (R2), SARIF URI decoding (R12).

function mkrepo(prefix: string): { repo: string; git: (a: string[]) => void } {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const git = (a: string[]) =>
    void execFileSync("git", a, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  git(["init", "-b", "main"]);
  return { repo, git };
}
const commit = (git: (a: string[]) => void, msg: string) => {
  git(["add", "-A"]);
  git(["-c", "commit.gpgsign=false", "commit", "-m", msg]);
};

describe("duplicate-line multiplicity (R4)", () => {
  it("introducing a copy of a known-bad line surfaces the copy as introduced", async () => {
    const { repo, git } = mkrepo("lev-r4-");
    writeFileSync(join(repo, "bad.py"), "print(foo)\n");
    commit(git, "base");
    git(["branch", "base"]);
    writeFileSync(join(repo, "bad.py"), "print(foo)\nprint(foo)\n");
    commit(git, "dup");
    const r = await scan({ repo, base: "base", engines: ["ruff"] });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ rule: "F821", line: 2, provenance: "introduced" });
    expect(r.preExisting).toBe(1); // one base occurrence, counted once
  });
});

describe("rename tracking (R5)", () => {
  it("a pure rename keeps its findings pre-existing", async () => {
    const { repo, git } = mkrepo("lev-r5-");
    writeFileSync(join(repo, "a.py"), "print(foo)\n");
    commit(git, "base");
    git(["branch", "base"]);
    git(["mv", "a.py", "b.py"]);
    commit(git, "rename only");
    const r = await scan({ repo, base: "base", engines: ["ruff"] });
    expect(r.findings).toEqual([]);
    expect(r.preExisting).toBe(1);
  });
});

describe("rule packs resolve against the head tree (R3)", () => {
  it("a pack added by the change still classifies pre-existing matches as pre-existing", async () => {
    const { repo, git } = mkrepo("lev-r3-");
    writeFileSync(join(repo, "app.py"), "x = eval('1')\n# base\n");
    commit(git, "base");
    git(["branch", "base"]);
    mkdirSync(join(repo, "sgrules"));
    writeFileSync(
      join(repo, "sgrules/no-eval.yml"),
      "id: sg-no-eval\nlanguage: python\nseverity: warning\nmessage: eval\nrule:\n  pattern: eval($X)\n",
    );
    writeFileSync(join(repo, "sgconfig.yml"), 'ruleDirs: ["sgrules"]\n');
    writeFileSync(join(repo, ".leveret.yml"), 'engines:\n  ast-grep:\n    rules: ["sgconfig.yml"]\n');
    writeFileSync(join(repo, "app.py"), "x = eval('1')\n# touched by head\n");
    commit(git, "add pack, touch file");
    const r = await scan({ repo, base: "base", engines: ["ast-grep"] });
    // the eval line existed at base; only the comment changed
    expect(r.findings).toEqual([]);
    expect(r.preExisting).toBe(1);
    expect(r.baseErrors ?? []).toEqual([]);
  });
});

describe("surfaced base-pass failures (R2)", () => {
  it("an engine that fails on the base tree lands in baseErrors instead of vanishing", async () => {
    const { repo, git } = mkrepo("lev-r2-");
    writeFileSync(join(repo, "target.txt"), "unchanged\n");
    writeFileSync(join(repo, "stub.sh"), "#!/bin/sh\necho 'not sarif at all'\nexit 1\n");
    chmodSync(join(repo, "stub.sh"), 0o755);
    commit(git, "base: stub crashes");
    git(["branch", "base"]);
    const sarif = JSON.stringify({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "stub" } },
          results: [
            {
              ruleId: "STUB1",
              level: "warning",
              message: { text: "hit" },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "target.txt" },
                    region: { startLine: 1 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    writeFileSync(join(repo, "stub.sh"), `#!/bin/sh\ncat <<'EOF'\n${sarif}\nEOF\n`);
    chmodSync(join(repo, "stub.sh"), 0o755);
    writeFileSync(join(repo, "target.txt"), "unchanged\ntouched\n");
    writeFileSync(
      join(repo, ".leveret.yml"),
      'custom:\n  - id: stub\n    command: ["./stub.sh"]\n    files: ["target.txt"]\n',
    );
    commit(git, "head: stub works, target touched");
    const r = await scan({ repo, base: "base", engines: ["stub"] });
    // head finding stays (provenance unknowable), but the base failure is VISIBLE
    expect(r.findings).toHaveLength(1);
    expect(r.baseErrors.some((e) => e.engine === "stub" && e.status === "error")).toBe(true);
  });
});

describe("SARIF URI decoding (R12)", () => {
  it("percent-encoded artifact URIs decode to real paths", () => {
    const doc = JSON.stringify({
      runs: [
        {
          results: [
            {
              ruleId: "X",
              level: "warning",
              message: { text: "m" },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "file://my%20file.txt" },
                    region: { startLine: 3 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(parseSarif("stub", doc)[0]).toMatchObject({ file: "my file.txt", line: 3 });
  });
});
