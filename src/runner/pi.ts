#!/usr/bin/env node
import {
  createAgentSession,
  createExtensionRuntime,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  VERSION as PI_VERSION,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadContract } from "../prompts.js";
import { which } from "../exec.js";
import { parseDuration, verifySchemaGaps } from "./omp.js";
import { buildPiSystemPrompt, PI_SYSTEM_PROMPT_VERSION } from "./pi-system.js";
import { buildPiTools } from "./pi-tools.js";
import { connectSerena, serenaBundleProblem } from "./serena.js";

export interface PiRunnerParams {
  model?: string;
  effort?: string;
  provider?: string;
  maxTime?: string;
}

export interface PiRuntimeConfig {
  model: string;
  provider: string;
  thinking: string;
  deadlineMs: number;
}

export function piRuntimeConfig(params: PiRunnerParams, env: Record<string, string | undefined>): PiRuntimeConfig {
  const maxTime = params.maxTime ?? env.LEVERET_RUNNER_MAX_TIME ?? "30m";
  const deadlineMs = parseDuration(maxTime);
  if (deadlineMs === null) throw new Error(`invalid max time: ${maxTime}`);
  return {
    model: params.model ?? env.LEVERET_RUNNER_MODEL ?? "gpt-5.6-sol",
    provider: params.provider ?? env.LEVERET_RUNNER_PROVIDER ?? "openai",
    thinking: params.effort ?? env.LEVERET_RUNNER_EFFORT ?? "high",
    deadlineMs,
  };
}

export function buildPiResourceLoader(systemPrompt: string): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export function parseAssistantJson(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) throw new Error("Pi assistant returned no JSON object");
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Pi assistant returned invalid JSON: ${String(error)}`);
  }
}

export interface ToolMetric {
  phase: "review" | "verify";
  toolCallId: string;
  toolName: string;
  startedAt: number;
  endedAt: number;
  isError: boolean;
}

export function toolMetricsSummary(metrics: ToolMetric[]): Record<string, Record<string, { calls: number; errors: number; duration_ms: number }>> {
  const result: Record<string, Record<string, { calls: number; errors: number; duration_ms: number }>> = {};
  for (const metric of metrics) {
    const phase = (result[metric.phase] ??= {});
    const entry = (phase[metric.toolName] ??= { calls: 0, errors: 0, duration_ms: 0 });
    entry.calls++;
    if (metric.isError) entry.errors++;
    entry.duration_ms += Math.max(0, metric.endedAt - metric.startedAt);
  }
  return result;
}

function piContract(text: string): string {
  return text.replace(/`leveret\.([a-z_]+)`/g, "`leveret_$1`");
}

async function withDeadline<T>(promise: Promise<T>, deadlineMs: number, abort: () => Promise<void>): Promise<T> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      void abort().finally(() => reject(new Error(`Pi phase exceeded ${deadlineMs}ms and was aborted`)));
    }, deadlineMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } catch (error) {
    if (timedOut) throw new Error(`Pi phase exceeded ${deadlineMs}ms and was aborted`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runPhase(options: {
  phase: "review" | "verify";
  prompt: string;
  repo: string;
  runtime: PiRuntimeConfig;
  modelRuntime: ModelRuntime;
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  systemPrompt: string;
  tools: Awaited<ReturnType<typeof buildPiTools>>["tools"];
  metrics: ToolMetric[];
}): Promise<unknown> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const settingsManager = SettingsManager.inMemory(
      {
        compaction: { enabled: false },
        retry: { enabled: false },
        enableInstallTelemetry: false,
        defaultProjectTrust: "never",
      },
      { projectTrusted: false },
    );
    const resourceLoader = buildPiResourceLoader(options.systemPrompt);
    const toolNames = ["read", "grep", "find", "ls", ...options.tools.map((tool) => tool.name)];
    const { session } = await createAgentSession({
      cwd: options.repo,
      agentDir: process.env.LEVERET_PI_AGENT_DIR ?? getAgentDir(),
      modelRuntime: options.modelRuntime,
      model: options.model,
      thinkingLevel: options.runtime.thinking as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
      tools: toolNames,
      customTools: options.tools,
      resourceLoader,
      sessionManager: SessionManager.inMemory(options.repo),
      settingsManager,
    });
    let assistantText = "";
    const starts = new Map<string, { name: string; at: number }>();
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        starts.set(event.toolCallId, { name: event.toolName, at: Date.now() });
      } else if (event.type === "tool_execution_end") {
        const start = starts.get(event.toolCallId);
        options.metrics.push({
          phase: options.phase,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          startedAt: start?.at ?? Date.now(),
          endedAt: Date.now(),
          isError: event.isError,
        });
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        assistantText = event.message.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("");
      }
    });
    try {
      await withDeadline(
        session.prompt(options.prompt, { expandPromptTemplates: false }),
        options.runtime.deadlineMs,
        () => session.abort(),
      );
      return parseAssistantJson(assistantText);
    } catch (error) {
      if (/exceeded .*ms/.test(String(error)) || attempt === 2) throw error;
    } finally {
      unsubscribe();
      session.dispose();
    }
  }
  throw new Error("Pi phase failed without an error");
}

function cliParams(argv: string[]): PiRunnerParams {
  const params: PiRunnerParams = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => (arg.includes("=") ? arg.split("=").slice(1).join("=") : argv[++i]!);
    if (arg === "--model" || arg.startsWith("--model=")) params.model = value();
    else if (arg === "--effort" || arg.startsWith("--effort=")) params.effort = value();
    else if (arg === "--provider" || arg.startsWith("--provider=")) params.provider = value();
    else if (arg === "--max-time" || arg.startsWith("--max-time=")) params.maxTime = value();
    else throw new Error(`unknown Pi runner argument: ${arg}`);
  }
  return params;
}

export async function main(): Promise<void> {
  const repo = process.env.LEVERET_REPO;
  const base = process.env.LEVERET_BASE;
  if (!repo || !base) throw new Error("LEVERET_REPO and LEVERET_BASE are required");
  const runtime = piRuntimeConfig(cliParams(process.argv.slice(2)), process.env);
  process.env.LEVERET_SANITIZE_CHILD_ENV = "1";
  process.env.PI_OFFLINE = "1";
  process.env.PI_TELEMETRY = "0";
  process.env.PI_SKIP_VERSION_CHECK = "1";

  const modelRuntime = await ModelRuntime.create({
    authPath: join(process.env.LEVERET_PI_AGENT_DIR ?? getAgentDir(), "auth.json"),
    modelsPath: join(process.env.LEVERET_PI_AGENT_DIR ?? getAgentDir(), "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const resolved = resolveCliModel({
    cliProvider: runtime.provider,
    cliModel: runtime.model,
    cliThinking: runtime.thinking as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
    modelRuntime,
  });
  if (!resolved.model) throw new Error(resolved.error ?? `Pi model not found: ${runtime.provider}/${runtime.model}`);

  let serena: Awaited<ReturnType<typeof connectSerena>> | undefined;
  let lspError: string | undefined;
  const serenaCommand = process.env.LEVERET_SERENA_BIN ?? "serena";
  const serenaExists = serenaCommand.includes("/") ? existsSync(serenaCommand) : await which(serenaCommand);
  const bundleProblem = serenaBundleProblem();
  if (bundleProblem) {
    lspError = bundleProblem;
  } else if (serenaExists) {
    try {
      serena = await connectSerena(repo, serenaCommand);
    } catch (error) {
      lspError = String(error).slice(0, 500);
    }
  } else {
    lspError = `${serenaCommand} not found`;
  }

  const bundle = await buildPiTools({
    repo,
    graphLive: process.env.LEVERET_GRAPH === "1",
    sandboxed: process.env.LEVERET_SANDBOXED === "1",
    serena,
  });
  const toolNames = ["read", "grep", "find", "ls", ...bundle.tools.map((tool) => tool.name)];
  const systemPrompt = buildPiSystemPrompt(toolNames);
  const systemPromptSha = createHash("sha256").update(systemPrompt).digest("hex");
  const metrics: ToolMetric[] = [];

  try {
    const reviewPrompt = piContract(await loadContract("review", { repo, base }));
    const review = await runPhase({
      phase: "review",
      prompt: reviewPrompt,
      repo,
      runtime,
      modelRuntime,
      model: resolved.model,
      systemPrompt,
      tools: bundle.tools,
      metrics,
    });
    const concerns = JSON.stringify((review as { concerns?: unknown[] }).concerns ?? [], null, 1);
    const leads = process.env.LEVERET_LEADS ? await readFile(process.env.LEVERET_LEADS, "utf8") : "(scan leads unavailable)";
    const prior = process.env.LEVERET_PRIOR ? await readFile(process.env.LEVERET_PRIOR, "utf8") : "";
    const verifyPrompt = [
      piContract(await loadContract("verify", { repo, base })),
      "\n## The review agent's concerns to verify\n",
      concerns,
      "\n## The scan leads\n",
      leads,
      ...(prior ? ["\n## Previously posted findings on this PR (judge each and emit resolutions)\n", prior] : []),
    ].join("\n");
    let verify = await runPhase({
      phase: "verify",
      prompt: verifyPrompt,
      repo,
      runtime,
      modelRuntime,
      model: resolved.model,
      systemPrompt,
      tools: bundle.tools,
      metrics,
    });
    const gaps = verifySchemaGaps(verify, Boolean(prior));
    if (gaps.length > 0) {
      verify = await runPhase({
        phase: "verify",
        prompt: `${verifyPrompt}\n\n## Schema correction\nYour previous answer was missing or empty: ${gaps.join(", ")}. Re-emit the full object required by the contract.`,
        repo,
        runtime,
        modelRuntime,
        model: resolved.model,
        systemPrompt,
        tools: bundle.tools,
        metrics,
      });
    }
    const out = verify as Record<string, unknown>;
    out.run_configuration = {
      harness: `pi/${PI_VERSION}`,
      client: "leveret-runner-pi",
      model: `${resolved.model.provider}/${resolved.model.id}`,
      thinking: runtime.thinking,
      auth: modelRuntime.isUsingSubscription(resolved.model.provider)
        ? "subscription-oauth"
        : modelRuntime.isUsingOAuth(resolved.model.provider)
          ? "oauth"
          : "api-key-or-local",
      system_prompt: { version: PI_SYSTEM_PROMPT_VERSION, sha256: systemPromptSha },
      capabilities: { ...bundle.capabilities, ...(lspError ? { lsp_error: lspError } : {}) },
      tools: toolMetricsSummary(metrics),
    };
    process.stdout.write(JSON.stringify(out, null, 1));
  } finally {
    await bundle.close();
  }
}

if (process.argv[1]?.endsWith("pi.js")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
