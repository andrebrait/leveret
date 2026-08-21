#!/usr/bin/env node
// leveret-runner-omp — the standardized App runner (DESIGN.md "Runner
// standardization"): omp.sh headless, purity fixed, provider/model/effort the
// caller's choice. Two phases: review contract -> concerns, verify contract ->
// {report, verdicts, coverage}, printed on stdout for the App to render.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { run, which } from "../exec.js";
import { loadContract } from "../prompts.js";

const exec = promisify(execFile);

/** Fixed standardization — never caller-overridable. */
export const PURITY_FLAGS = [
  "--no-skills",
  "--no-extensions",
  "--no-rules",
  "--no-session",
  "--no-lsp",
] as const;

// flags a passthrough must not smuggle back in
const HOSTILE = [/^--skills(=|$)/, /^--lsp(=|$)?$/, /^--extension/, /^--rules/, /^--hook/];

export interface RunnerParams {
  model?: string;
  effort?: string;
  provider?: string;
  maxTime?: string;
  ompArgs?: string[];
}

export function buildOmpArgs(p: RunnerParams, env: Record<string, string | undefined>): string[] {
  const model = p.model ?? env.LEVERET_RUNNER_MODEL ?? "gpt-5.6-sol";
  const effort = p.effort ?? env.LEVERET_RUNNER_EFFORT ?? "high";
  const provider = p.provider ?? env.LEVERET_RUNNER_PROVIDER;
  const maxTime = p.maxTime ?? env.LEVERET_RUNNER_MAX_TIME ?? "30m";
  const passthrough = (p.ompArgs ?? env.LEVERET_RUNNER_OMP_ARGS?.split(" ") ?? []).filter(
    (a) => a && !HOSTILE.some((h) => h.test(a)),
  );
  return [
    "-p",
    "--mode=json",
    `--model=${model}`,
    `--thinking=${effort}`,
    ...(provider ? [`--provider=${provider}`] : []),
    `--max-time=${maxTime}`,
    "--approval-mode=yolo",
    ...PURITY_FLAGS,
    ...passthrough,
  ];
}

export interface OmpRunResult {
  json: unknown;
  toolCalls: Record<string, number>;
  mcpCalls: string[];
}

/** omp --mode json emits one event per line; the answer is the LAST assistant
 * message whose text parses as JSON. MCP calls surface as write-tool xd:// URIs. */
export function parseOmpEvents(stream: string): OmpRunResult {
  const toolCalls: Record<string, number> = {};
  const mcpCalls: string[] = [];
  let json: unknown;
  for (const line of stream.split("\n")) {
    if (!line.trim()) continue;
    let d: {
      type?: string;
      toolName?: string;
      args?: { path?: string };
      message?: { role?: string; content?: { type?: string; text?: string }[] };
    };
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type === "tool_execution_start" && d.toolName) {
      toolCalls[d.toolName] = (toolCalls[d.toolName] ?? 0) + 1;
      const m = d.args?.path?.match(/^xd:\/\/(mcp__[a-z0-9_]+)/i);
      if (m) mcpCalls.push(m[1]!);
    }
    if (d.type === "message_end" && d.message?.role === "assistant") {
      const text = (d.message.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      const trimmed = text.trim().replace(/^```(?:json)?\n?|\n?```$/g, "");
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          json = JSON.parse(trimmed);
        } catch {
          /* prose that merely starts with a brace */
        }
      }
    }
  }
  if (json === undefined) {
    throw new Error(`omp produced no JSON answer; stream tail: ${stream.slice(-300)}`);
  }
  return { json, toolCalls, mcpCalls };
}

const COMPACTION_OVERLAY = `compaction:
  enabled: false
  midTurnEnabled: false
lsp:
  enabled: false
mcp:
  enableProjectConfig: true
`;

async function phase(
  repo: string,
  prompt: string,
  args: string[],
  overlayPath: string,
): Promise<OmpRunResult> {
  const promptPath = join(repo, `.leveret-prompt-${Math.random().toString(36).slice(2, 8)}.md`);
  await writeFile(promptPath, prompt);
  const r = await exec("omp", [...args, `--config=${overlayPath}`, `@${promptPath}`], {
    cwd: repo,
    maxBuffer: 256 * 1024 * 1024,
  });
  return parseOmpEvents(r.stdout);
}

function cliParams(argv: string[]): RunnerParams {
  const p: RunnerParams = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = () => a.includes("=") ? a.split("=").slice(1).join("=") : argv[++i]!;
    if (a.startsWith("--model")) p.model = val();
    else if (a.startsWith("--effort")) p.effort = val();
    else if (a.startsWith("--provider")) p.provider = val();
    else if (a.startsWith("--max-time")) p.maxTime = val();
    else if (a.startsWith("--omp-arg")) (p.ompArgs ??= []).push(val());
  }
  return p;
}

export async function main(): Promise<void> {
  const repo = process.env.LEVERET_REPO;
  const base = process.env.LEVERET_BASE;
  if (!repo || !base) throw new Error("LEVERET_REPO and LEVERET_BASE are required");
  const params = cliParams(process.argv.slice(2));
  const args = buildOmpArgs(params, process.env);

  // serena pre-warm is best-effort: the agent degrades to ast_search/grep without it
  if (await which("serena")) {
    await run("serena", ["project", "index", repo], repo);
  }

  const overlayPath = join(await mkdtemp(join(tmpdir(), "leveret-runner-")), "overlay.yml");
  await writeFile(overlayPath, COMPACTION_OVERLAY);

  const reviewPrompt = await loadContract("review", { repo, base });
  const review = await phase(repo, reviewPrompt, args, overlayPath);
  const concerns = JSON.stringify((review.json as { concerns?: unknown[] }).concerns ?? [], null, 1);

  const leads = process.env.LEVERET_LEADS
    ? await readFile(process.env.LEVERET_LEADS, "utf8")
    : "(scan leads unavailable)";
  const verifyPrompt = [
    await loadContract("verify", { repo, base }),
    "\n## The review agent's concerns to verify\n",
    concerns,
    "\n## The scan leads\n",
    leads,
  ].join("\n");
  const verify = await phase(repo, verifyPrompt, args, overlayPath);

  const out = verify.json as Record<string, unknown>;
  // run-configuration line data for the walkthrough: standardization is auditable
  const version = (await run("omp", ["--version"], repo)).stdout.trim().split("\n")[0] ?? "omp";
  out.run_configuration = {
    harness: version,
    model: args.find((a) => a.startsWith("--model="))?.slice(8),
    thinking: args.find((a) => a.startsWith("--thinking="))?.slice(11),
    mcp: [...new Set([...review.mcpCalls, ...verify.mcpCalls])],
  };
  process.stdout.write(JSON.stringify(out, null, 1));
}

// bin entry (skipped under vitest import)
if (process.argv[1]?.endsWith("omp.js")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
