#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { astSearch } from "./astsearch.js";
import { context } from "./context.js";
import { loadContract } from "./prompts.js";
import { learn, memoryList, remember } from "./memory.js";
import { scan } from "./scan.js";

const server = new McpServer({ name: "leveret", version: "0.1.0" });

server.registerTool(
  "scan",
  {
    description:
      "Run the applicable static-analysis engines (semgrep security rules, gitleaks secrets, " +
      "shellcheck, ruff, actionlint, zizmor, osv-scanner, typos, jscpd, ast-grep rule packs, " +
      "custom SARIF) over a " +
      "change set and return normalized findings plus per-engine status " +
      "(findings | clean | filtered | not-applicable | missing | error, with found/kept counts). " +
      "Findings are review LEADS, not verdicts: validate each against current code. " +
      "Give either base (git ref; scans base...HEAD changed files, secrets over base..HEAD " +
      "commits) or an explicit files list (repo-relative). A .leveret.yml profile in the " +
      "repo (or profilePath) scopes engines by path and suppresses priced rules; " +
      "suppressions come back tallied with their reasons, never silently.",
    inputSchema: {
      repo: z.string().describe("absolute path to the git repo / worktree to scan"),
      base: z.string().optional().describe("git base ref, e.g. origin/devel"),
      files: z.array(z.string()).optional().describe("explicit repo-relative files"),
      engines: z
        .array(z.string())
        .optional()
        .describe("restrict to these engine ids (default: all applicable)"),
      profilePath: z
        .string()
        .optional()
        .describe("profile file overriding <repo>/.leveret.yml"),
    },
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await scan(args), null, 1) }],
  }),
);

server.registerTool(
  "ast_search",
  {
    description:
      "Structural code search via ast-grep: match a syntax-aware pattern (metavariables like " +
      "$X, $$$ARGS) instead of text. Use for 'every call site shaped like this' questions " +
      "a text grep gets wrong. Returns file/line/matched text.",
    inputSchema: {
      repo: z.string().describe("absolute path to the repo to search"),
      pattern: z.string().describe("ast-grep pattern, e.g. foo($$$ARGS)"),
      lang: z.string().describe("language id: php, python, bash, javascript, typescript, ..."),
      paths: z.array(z.string()).optional().describe("restrict to these paths (default repo root)"),
    },
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await astSearch(args), null, 1) }],
  }),
);

server.registerTool(
  "context",
  {
    description:
      "Prioritization context for reviewing a change — NOT findings: per-function " +
      "cyclomatic complexity (lizard, multi-language), 12-month git churn, and " +
      "last-touched date per file. High complexity in a high-churn file deserves the " +
      "deepest review; use this to decide where to dig before reading code.",
    inputSchema: {
      repo: z.string().describe("absolute path to the repo"),
      files: z.array(z.string()).describe("repo-relative files to profile"),
    },
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await context(args), null, 1) }],
  }),
);

server.registerTool(
  "remember",
  {
    description:
      "Persist a graded verdict to the repo's review memory (.leveret/memory.jsonl) so " +
      "the finding class never re-surfaces ungraded. Grades: priced-noise (true but the " +
      "repo prices fixing it at zero) or false-positive (the claim is wrong). Only drops " +
      "are stored — actionable findings are reported, not remembered. Give anchorFile + " +
      "anchorLine to pin an instance verdict to its source line: the memory dies when " +
      "that line changes. Omit the anchor for a class-wide verdict (fp may use a glob).",
    inputSchema: {
      repo: z.string().describe("absolute path to the reviewed repo"),
      fp: z.string().describe("fingerprint: engine/RULE/path-or-glob, e.g. shellcheck/SC2016/tests/**"),
      grade: z.enum(["priced-noise", "false-positive"]),
      reason: z.string().describe("why this class is priced or false — mandatory, auditable"),
      author: z.string().optional().describe("who graded (agent id or human)"),
      anchorFile: z.string().optional().describe("repo-relative file for an instance anchor"),
      anchorLine: z.number().optional().describe("1-based line the verdict anchors to"),
    },
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await remember(args), null, 1) }],
  }),
);

server.registerTool(
  "memory",
  {
    description:
      "List the repo's review-memory entries (fingerprint, grade, reason, created, " +
      "lastApplied). Use lastApplied to spot dead pricing worth deleting, and repeated " +
      "same-rule entries under one subtree as candidates for promotion to a glob memory " +
      "or a .leveret.yml profile rule.",
    inputSchema: {
      repo: z.string().describe("absolute path to the reviewed repo"),
    },
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await memoryList(args), null, 1) }],
  }),
);

server.registerTool(
  "learn",
  {
    description:
      "Persist a human-taught convention to the repo's review memory: free-text " +
      "teaching sourced from feedback on a finding (a maintainer reply, an explicit " +
      "instruction). Conventions are injected into the review/verify prompts, where " +
      "they both suppress priced classes and RAISE findings that violate them; they " +
      "are never matched mechanically and never garbage-collected — a human retires " +
      "one by deleting its line. Always attribute: author is the human whose ruling " +
      "this is, not the agent relaying it.",
    inputSchema: {
      repo: z.string().describe("absolute path to the reviewed repo"),
      text: z.string().describe("the ruling, in the human's words"),
      author: z.string().describe("the human who taught it (e.g. GitHub login)"),
      scope: z.array(z.string()).optional().describe("path globs bounding the ruling"),
    },
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await learn(args), null, 1) }],
  }),
);

server.registerPrompt(
  "review",
  {
    description:
      "Contract for the read-only review agent: gather scan leads, context, diff and " +
      "cross-file blast radius, run every lens, emit falsifiable concerns as JSON.",
    argsSchema: { repo: z.string(), base: z.string() },
  },
  async ({ repo, base }) => ({
    messages: [
      { role: "user", content: { type: "text", text: await loadContract("review", { repo, base }) } },
    ],
  }),
);

server.registerPrompt(
  "verify",
  {
    description:
      "Contract for the adversarial verification agent: refute-or-evidence every " +
      "concern and lead, grade actionable / priced-noise / false-positive, persist " +
      "drops via remember, report only what survives.",
    argsSchema: { repo: z.string(), base: z.string() },
  },
  async ({ repo, base }) => ({
    messages: [
      { role: "user", content: { type: "text", text: await loadContract("verify", { repo, base }) } },
    ],
  }),
);

await server.connect(new StdioServerTransport());
