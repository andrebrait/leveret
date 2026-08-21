import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderInline, renderWalkthrough } from "../src/app/render.js";
import { routeEvent, verifySignature } from "../src/app/webhook.js";
import type { ScanResult } from "../src/findings.js";
import type { VerifyOutput } from "../src/app/render.js";

// App layer: GitHub plumbing only. The pure parts — signature check, event
// routing, report rendering — are what these tests pin; API calls stay thin.

const SECRET = "test-secret";
const sign = (body: string) =>
  `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

describe("webhook signature", () => {
  it("accepts a correctly signed payload and rejects tampering", () => {
    const body = '{"a":1}';
    expect(verifySignature(SECRET, body, sign(body))).toBe(true);
    expect(verifySignature(SECRET, body + " ", sign(body))).toBe(false);
    expect(verifySignature(SECRET, body, "sha256=deadbeef")).toBe(false);
    expect(verifySignature(SECRET, body, undefined)).toBe(false);
  });
});

describe("event routing", () => {
  const pr = {
    number: 7,
    head: { sha: "abc123" },
    base: { ref: "main", repo: { full_name: "o/r", clone_url: "https://x/o/r.git" } },
  };

  it("opened and synchronize PRs become review jobs", () => {
    for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
      const job = routeEvent("pull_request", { action, pull_request: pr });
      expect(job).toMatchObject({ kind: "review", repo: "o/r", pr: 7, headSha: "abc123", baseRef: "main" });
    }
  });

  it("closed and labeled PRs are ignored", () => {
    expect(routeEvent("pull_request", { action: "closed", pull_request: pr })).toBeNull();
    expect(routeEvent("pull_request", { action: "labeled", pull_request: pr })).toBeNull();
  });

  it("a human reply on a leveret finding feeds learn; other comments do not", () => {
    const base = {
      action: "created",
      repository: { full_name: "o/r" },
      issue: { number: 7, pull_request: {} },
    };
    const onOurs = routeEvent("pull_request_review_comment", {
      ...base,
      comment: {
        id: 2,
        user: { login: "andrebrait", type: "User" },
        body: "won't fix — we do X here",
        in_reply_to_id: 1,
      },
      pull_request: pr,
    });
    expect(onOurs).toMatchObject({ kind: "learn-feed", repo: "o/r", pr: 7, author: "andrebrait" });
    // bot replies never teach
    const botReply = routeEvent("pull_request_review_comment", {
      ...base,
      comment: { id: 3, user: { login: "some[bot]", type: "Bot" }, body: "beep", in_reply_to_id: 1 },
      pull_request: pr,
    });
    expect(botReply).toBeNull();
  });
});

const verifyOutput: VerifyOutput = {
  report: [
    { id: "R2", file: "b.ts", line: 5, title: "minor thing", tier: "minor", severity: "info", scope: "in-diff", evidence: "e2" },
    { id: "R1", file: "a.ts", line: 3, title: "big thing", tier: "critical", severity: "error", scope: "in-diff", evidence: "e1", suggested_fix: "do X" },
    { id: "R3", file: "c.ts", line: 9, title: "sibling copy of the fixed bug", tier: "major", severity: "warning", scope: "out-of-diff", correlation: "same pattern as the a.ts fix", evidence: "e3" },
  ],
  verdicts: [
    { id: "R1", grade: "actionable" },
    { id: "R2", grade: "actionable" },
    { id: "R3", grade: "actionable" },
    { id: "L1", grade: "priced-noise", reason: "repo convention" },
    { id: "L2", grade: "dropped", reason: "unverifiable" },
  ],
  coverage: {
    lenses: [
      { lens: "correctness-hostile-inputs", outcome: "2 concerns" },
      { lens: "test-honesty", outcome: "clean" },
    ],
    files: [
      { file: "a.ts", verdict: "findings" },
      { file: "docs/x.md", verdict: "not-examined", note: "prose only" },
    ],
  },
};

const scanResult: ScanResult = {
  findings: [],
  engines: [
    { engine: "ruff", status: "filtered", found: 2, kept: 0 },
    { engine: "typos", status: "clean", found: 0, kept: 0 },
  ],
  suppressed: [{ rule: "typos/typo", count: 3, reason: "fixture plants" }],
  preExisting: 4,
  baseErrors: [],
  reminders: [
    { engine: "ruff", rule: "F821", severity: "warning", file: "a.ts", line: 40, message: "old defect next door", provenance: "pre-existing" },
  ],
};

describe("rendering", () => {
  it("walkthrough groups by tier (most severe first), sections out-of-diff and reminders, and shows coverage", () => {
    const md = renderWalkthrough(verifyOutput, scanResult);
    // tier order: critical before major before minor
    expect(md.indexOf("big thing")).toBeLessThan(md.indexOf("sibling copy"));
    expect(md.indexOf("sibling copy")).toBeLessThan(md.indexOf("minor thing"));
    // out-of-diff section with correlation
    expect(md).toMatch(/out-of-diff/i);
    expect(md).toContain("same pattern as the a.ts fix");
    // reminders section
    expect(md).toContain("old defect next door");
    // what-was-checked walkthrough: lenses incl clean, per-file verdicts
    expect(md).toContain("test-honesty");
    expect(md).toContain("clean");
    expect(md).toContain("not-examined");
    // nothing dropped silently
    expect(md).toContain("fixture plants");
    expect(md).toMatch(/4 pre-existing/);
    expect(md).toMatch(/dropped/i);
  });

  it("the walkthrough states whether the graph surface was live — a reviewer capability, not a repo property", () => {
    const withGraph = renderWalkthrough(verifyOutput, scanResult, { ok: true });
    expect(withGraph).toMatch(/code graph.*live/i);
    const without = renderWalkthrough(verifyOutput, scanResult, { ok: false, detail: "codegraph not on PATH" });
    expect(without).toMatch(/code graph.*unavailable/i);
    expect(without).toContain("codegraph not on PATH");
  });

  it("inline comments cover only in-diff findings, tier-tagged", () => {
    const inline = renderInline(verifyOutput);
    expect(inline).toHaveLength(2);
    expect(inline[0]).toMatchObject({ path: "a.ts", line: 3 });
    expect(inline[0]!.body).toContain("critical");
    expect(inline[0]!.body).toContain("do X");
    expect(inline.some((c) => c.path === "c.ts")).toBe(false);
  });
});

describe("acknowledgement messages", () => {
  it("the ack names the commit and sets expectations, in Leveret's own voice", async () => {
    const { ackMessage } = await import("../src/app/render.js");
    const msg = ackMessage("abc123def456", "gpt-5.6-sol");
    expect(msg).toContain("abc123d"); // short sha
    expect(msg).toContain("gpt-5.6-sol");
    expect(msg).toMatch(/🐇/);
    // not CodeRabbit's furniture ("walkthrough" is Leveret's own established term)
    expect(msg).not.toMatch(/Tip:|<details>|Review Stack|chill/i);
  });

  it("the done edit reports tier counts and examined totals", async () => {
    const { doneMessage } = await import("../src/app/render.js");
    const msg = doneMessage(verifyOutput);
    expect(msg).toMatch(/1 critical/);
    expect(msg).toMatch(/1 major/);
    expect(msg).toMatch(/1 minor/);
    expect(msg).toMatch(/5 .*(examined|judged)/);
    expect(msg).toMatch(/🐇/);
  });

  it("the failure edit says what broke instead of vanishing", async () => {
    const { failMessage } = await import("../src/app/render.js");
    const msg = failMessage(new Error("omp exploded"));
    expect(msg).toContain("omp exploded");
    expect(msg).toMatch(/🐇/);
  });
});

describe("skip configuration and notice", () => {
  it("routeEvent carries action and title so skips can be judged and de-duplicated", () => {
    const job = routeEvent("pull_request", {
      action: "opened",
      pull_request: {
        number: 9,
        title: "feat: thing [skip leveret]",
        head: { sha: "abc" },
        base: { ref: "main", repo: { full_name: "o/r", clone_url: "u" } },
      },
    });
    expect(job).toMatchObject({ kind: "review", action: "opened", title: "feat: thing [skip leveret]" });
  });

  it("the skip notice names the config that ruled, in Leveret's voice", async () => {
    const { skipMessage } = await import("../src/app/render.js");
    const msg = skipMessage("review.enabled is false in .leveret.yml");
    expect(msg).toMatch(/🐇/);
    expect(msg).toContain("review.enabled is false in .leveret.yml");
    expect(msg).toMatch(/noticed/i);
  });

  it("profile parses the review block; enabled defaults to true", async () => {
    const { loadProfile } = await import("../src/profile.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const d = mkdtempSync(join(tmpdir(), "lev-skipcfg-"));
    writeFileSync(join(d, "p.yml"), "review:\n  enabled: false\n  skipTitle: '\\[hold\\]'\n");
    const p = await loadProfile(join(d, "p.yml"));
    expect(p.review.enabled).toBe(false);
    expect(p.review.skipTitle).toBe("\\[hold\\]");
    const empty = await loadProfile(join(d, "missing.yml"));
    expect(empty.review.enabled).toBe(true);
  });
});
