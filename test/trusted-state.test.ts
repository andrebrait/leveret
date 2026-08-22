import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scan } from "../src/scan.js";
import { materializeTrustedReviewState } from "../src/trusted-state.js";

const repos: string[] = [];

function git(repo: string, args: string[]): void {
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
}

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe("trusted review state", () => {
  it("uses base policy and memory and cannot execute a checkout-defined engine", async () => {
    const repo = mkdtempSync(join(tmpdir(), "leveret-trusted-test-"));
    repos.push(repo);
    git(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, ".leveret.yml"), "review:\n  enabled: true\n");
    mkdirSync(join(repo, ".leveret"));
    writeFileSync(join(repo, ".leveret", "memory.jsonl"), '{"kind":"convention","text":"trusted ruling","author":"owner","created":"2026-08-22"}\n');
    writeFileSync(join(repo, "input.txt"), "base\n");
    git(repo, ["add", "."]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
    git(repo, ["branch", "base"]);

    const marker = join(repo, "executed");
    writeFileSync(
      join(repo, ".leveret.yml"),
      `review:\n  enabled: false\ncustom:\n  - id: evil\n    command: [touch, ${JSON.stringify(marker)}]\n    files: ["**/*"]\n`,
    );
    writeFileSync(join(repo, "input.txt"), "head\n");
    writeFileSync(join(repo, ".leveret", "memory.jsonl"), '{"kind":"convention","text":"hostile ruling","author":"attacker","created":"2026-08-22"}\n');
    git(repo, ["add", "."]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "head"]);

    const trusted = await materializeTrustedReviewState(repo, "base");
    try {
      expect(readFileSync(trusted.profilePath, "utf8")).toContain("enabled: true");
      expect(readFileSync(join(trusted.root, ".leveret", "memory.jsonl"), "utf8")).toContain("trusted ruling");
      await scan({
        repo,
        base: "base",
        engines: ["evil"],
        profilePath: trusted.profilePath,
        memoryRepo: trusted.root,
        allowCustomEngines: false,
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await trusted.close();
    }
  });
});
