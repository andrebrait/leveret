#!/usr/bin/env node
// leveret-runner-omp — the standardized App runner (DESIGN.md "Runner
// standardization"): omp.sh headless, purity fixed, provider/model/effort the
// caller's choice. Two phases: review contract -> concerns, verify contract ->
// {report, verdicts, coverage}, printed on stdout for the App to render.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

export interface CaptureResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** The phase executor: stdin IGNORED (omp waits for stdin EOF in print mode and
 * wedged two live reviews behind an execFile pipe), output captured, hard
 * deadline enforced by SIGKILL. */
export function spawnCapture(
  cmd: string,
  args: string[],
  cwd: string,
  deadlineMs: number,
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, deadlineMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr, timedOut });
    });
  });
}

/** Crash-retry policy (external AI can crash or drop mid-stream): one retry on a
 * crash, never on a deadline kill — a wedge twice over is not worth the budget. */
export async function runPhaseCommand(
  cmd: string,
  args: string[],
  cwd: string,
  deadlineMs: number,
): Promise<CaptureResult> {
  for (let attempt = 1; ; attempt++) {
    const r = await spawnCapture(cmd, args, cwd, deadlineMs);
    if (r.timedOut) throw new Error(`${cmd} exceeded the phase deadline and was killed`);
    if (r.code === 0) return r;
    if (attempt >= 2) throw new Error(`${cmd} rc=${r.code} after ${attempt} attempts: ${r.stderr.slice(0, 300)}`);
  }
}

/** omp-style duration to ms: "30m", "1h", bare seconds. null = unparseable. */
export function parseDuration(v: string): number | null {
  const m = v.match(/^(\d+)([smh]?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "h" ? n * 3_600_000 : m[2] === "m" ? n * 60_000 : n * 1000;
}

export interface McpConfig {
  mcpServers: Record<string, { command: string; args: string[] }>;
}

/** The agent's toolbelt over MCP: leveret's own server (resolved beside this
 * runner script) and codegraph when the graph is live. omp integrates serena
 * natively, so it needs no entry here. */
export function buildMcpConfig(runnerScriptPath: string, graphLive: boolean): McpConfig {
  const serverPath = join(dirname(dirname(runnerScriptPath)), "server.js");
  return {
    mcpServers: {
      leveret: { command: "node", args: [serverPath] },
      ...(graphLive ? { codegraph: { command: "codegraph", args: ["serve", "--mcp"] } } : {}),
    },
  };
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
  // Outer deadline, belt over omp's own --max-time suspenders: a wedged omp has
  // been observed sailing past its internal timer, so the runner enforces
  // max-time + 5 minutes itself; crashes retry once (runPhaseCommand).
  const maxTime = args.find((a) => a.startsWith("--max-time="))?.slice("--max-time=".length) ?? "30m";
  const deadlineMs = (parseDuration(maxTime) ?? 1_800_000) + 300_000;
  const r = await runPhaseCommand("omp", [...args, `--config=${overlayPath}`, `@${promptPath}`], repo, deadlineMs);
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

  // serena pre-warm is best-effort AND hard-capped: a wedged index must never
  // stall the review (it did, once — the first live PR sat 13 minutes behind it)
  if (await which("serena")) {
    await run("serena", ["project", "index", repo], repo, { timeoutMs: 120_000 });
  }

  // the agent's MCP toolbelt: written into the checkout unless the repo ships its own
  const mcpPath = join(repo, ".mcp.json");
  if (!existsSync(mcpPath)) {
    const scriptPath = process.argv[1] ?? "";
    await writeFile(mcpPath, JSON.stringify(buildMcpConfig(scriptPath, process.env.LEVERET_GRAPH === "1"), null, 1));
  }

  const overlayPath = join(await mkdtemp(join(tmpdir(), "leveret-runner-")), "overlay.yml");
  await writeFile(overlayPath, COMPACTION_OVERLAY);

  const reviewPrompt = await loadContract("review", { repo, base });
  const review = await phase(repo, reviewPrompt, args, overlayPath);
  const concerns = JSON.stringify((review.json as { concerns?: unknown[] }).concerns ?? [], null, 1);

  const leads = process.env.LEVERET_LEADS
    ? await readFile(process.env.LEVERET_LEADS, "utf8")
    : "(scan leads unavailable)";
  const prior = process.env.LEVERET_PRIOR
    ? await readFile(process.env.LEVERET_PRIOR, "utf8")
    : "";
  const verifyPrompt = [
    await loadContract("verify", { repo, base }),
    "\n## The review agent's concerns to verify\n",
    concerns,
    "\n## The scan leads\n",
    leads,
    ...(prior ? ["\n## The bot's previously posted findings on this PR (judge each; emit resolutions)\n", prior] : []),
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
