#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { astSearch } from "./astsearch.js";
import { scan } from "./scan.js";

const server = new McpServer({ name: "warren", version: "0.1.0" });

server.registerTool(
  "scan",
  {
    description:
      "Run the applicable static-analysis engines (semgrep security rules, gitleaks secrets, " +
      "shellcheck, ruff, actionlint) over a change set and return normalized findings. " +
      "Findings are review LEADS, not verdicts: validate each against current code. " +
      "Give either base (git ref; scans base...HEAD changed files, secrets over base..HEAD " +
      "commits) or an explicit files list (repo-relative).",
    inputSchema: {
      repo: z.string().describe("absolute path to the git repo / worktree to scan"),
      base: z.string().optional().describe("git base ref, e.g. origin/devel"),
      files: z.array(z.string()).optional().describe("explicit repo-relative files"),
      engines: z
        .array(z.string())
        .optional()
        .describe("restrict to these engine ids (default: all applicable)"),
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

await server.connect(new StdioServerTransport());
