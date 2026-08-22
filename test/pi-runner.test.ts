import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { run } from "../src/exec.js";
import { prefetchSerena } from "../src/runner/prefetch-serena.js";
import { buildPiSystemPrompt } from "../src/runner/pi-system.js";
import {
  buildPiResourceLoader,
  parseAssistantJson,
  piRuntimeConfig,
  toolMetricsSummary,
} from "../src/runner/pi.js";
import {
  buildSerenaArgs,
  prepareSerenaProject,
  safeToolEnvironment,
  serenaBundleProblem,
  serenaPrefetchFixtures,
  serenaProjectConfigProblem,
} from "../src/runner/serena.js";
import { buildPiTools } from "../src/runner/pi-tools.js";

describe("Pi runtime isolation", () => {
  it("ships Pi as the standard runner while retaining the OMP rollback binary", async () => {
    const { readFileSync } = await import("node:fs");
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.bin).toMatchObject({
      "leveret-runner-pi": "dist/runner/pi.js",
      "leveret-runner-omp": "dist/runner/omp.js",
      "leveret-prefetch-serena": "dist/runner/prefetch-serena.js",
    });
    expect(manifest.dependencies["@earendil-works/pi-coding-agent"]).toBe("0.84.2");
  });

  it("uses a fully explicit in-memory configuration", () => {
    const cfg = piRuntimeConfig(
      { model: "gpt-5.6-sol", provider: "openai", effort: "high", maxTime: "20m" },
      {},
    );
    expect(cfg).toMatchObject({
      model: "gpt-5.6-sol",
      provider: "openai",
      thinking: "high",
      deadlineMs: 20 * 60_000,
    });
  });

  it("does not expose project resources or append prompts", async () => {
    const loader = buildPiResourceLoader("trusted prompt");
    await loader.reload();
    expect(loader.getSystemPrompt()).toBe("trusted prompt");
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(loader.getAgentsFiles()).toEqual({ agentsFiles: [] });
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
  });

  it("registers no mutation or unrestricted shell tools", async () => {
    const tools = await buildPiTools({ repo: "/tmp/repo", graphLive: false, sandboxed: false });
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toContain("leveret_scan");
    expect(names).toContain("leveret_ast_search");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("write");
    expect(names).not.toContain("leveret_probe");
    await tools.close();
  });

  it("only exposes probes when the caller proves sandboxing", async () => {
    const tools = await buildPiTools({ repo: "/tmp/repo", graphLive: false, sandboxed: true });
    expect(tools.tools.map((tool) => tool.name)).toContain("leveret_probe");
    await tools.close();
  });

  it("pins the required provider and model catalog without a network refresh", async () => {
    const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false, modelsPath: null });
    for (const provider of ["anthropic", "openai", "openai-codex", "github-copilot"]) {
      expect(runtime.getProvider(provider), provider).toBeDefined();
    }
    expect(runtime.getModel("openai", "gpt-5.6-sol")).toBeDefined();
    expect(runtime.getModel("openai-codex", "gpt-5.6-sol")).toBeDefined();
  });

  it("builds routing guidance from exactly the active tools", () => {
    const prompt = buildPiSystemPrompt(["leveret_scan", "codegraph_explore"]);
    expect(prompt).toContain("leveret_scan");
    expect(prompt).toContain("codegraph_explore");
    expect(prompt).not.toContain("lsp_references");
    expect(prompt).toMatch(/read-only/i);
  });

  it("keeps provider and GitHub credentials out of child tools", async () => {
    const old = {
      sanitize: process.env.LEVERET_SANITIZE_CHILD_ENV,
      openai: process.env.OPENAI_API_KEY,
      github: process.env.GITHUB_TOKEN,
    };
    process.env.LEVERET_SANITIZE_CHILD_ENV = "1";
    process.env.OPENAI_API_KEY = "must-not-leak";
    process.env.GITHUB_TOKEN = "must-not-leak";
    try {
      const result = await run("/usr/bin/env", [], "/tmp");
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain("OPENAI_API_KEY");
      expect(result.stdout).not.toContain("GITHUB_TOKEN");
    } finally {
      if (old.sanitize === undefined) delete process.env.LEVERET_SANITIZE_CHILD_ENV;
      else process.env.LEVERET_SANITIZE_CHILD_ENV = old.sanitize;
      if (old.openai === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = old.openai;
      if (old.github === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = old.github;
    }
  });
});

describe("Pi result and metrics parsing", () => {
  it("accepts fenced JSON and rejects prose", () => {
    expect(parseAssistantJson('```json\n{"concerns":[]}\n```')).toEqual({ concerns: [] });
    expect(() => parseAssistantJson("looks good")).toThrow(/JSON/i);
  });

  it("summarizes phase-attributed tool events", () => {
    const summary = toolMetricsSummary([
      { phase: "review", toolCallId: "1", toolName: "codegraph_explore", startedAt: 10, endedAt: 30, isError: false },
      { phase: "review", toolCallId: "2", toolName: "codegraph_explore", startedAt: 40, endedAt: 55, isError: true },
      { phase: "verify", toolCallId: "3", toolName: "lsp_references", startedAt: 60, endedAt: 70, isError: false },
    ]);
    expect(summary).toEqual({
      review: { codegraph_explore: { calls: 2, errors: 1, duration_ms: 35 } },
      verify: { lsp_references: { calls: 1, errors: 0, duration_ms: 10 } },
    });
  });
});

describe("Serena headless and offline staging", () => {
  it("disables dashboard, tray, GUI, and usage reporting", () => {
    expect(buildSerenaArgs("/repo")).toEqual([
      "start-mcp-server",
      "--project",
      "/repo",
      "--transport",
      "stdio",
      "--enable-web-dashboard",
      "false",
      "--enable-gui-log-window",
      "false",
      "--open-web-dashboard",
      "false",
    ]);
    const env = safeToolEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/test",
      OPENAI_API_KEY: "secret",
      GITHUB_TOKEN: "secret",
      SERENA_HOME: "/opt/serena",
    });
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/test",
      SERENA_HOME: "/opt/serena",
      SERENA_USAGE_REPORTING: "false",
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("defines a small explicit fixture set for build-time prefetch", () => {
    const fixtures = serenaPrefetchFixtures();
    expect(fixtures.map((f) => f.language)).toEqual([
      "typescript",
      "python",
      "php",
      "bash",
      "yaml",
      "json",
      "cpp",
      "go",
      "rust",
      "java",
    ]);
    for (const fixture of fixtures) {
      expect(fixture.files.length).toBeGreaterThan(0);
    }
  });

  it("refuses dynamic downloads and project-controlled Serena settings", async () => {
    expect(serenaBundleProblem({})).toMatch(/SERENA_HOME/);
    expect(serenaBundleProblem({ SERENA_HOME: "/missing" })).toMatch(/manifest/);
    expect(serenaBundleProblem({ LEVERET_ALLOW_UNPACKAGED_SERENA: "1" })).toBeNull();

    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const repo = mkdtempSync(join(tmpdir(), "leveret-hostile-serena-"));
    expect(serenaProjectConfigProblem(repo)).toBeNull();
    mkdirSync(join(repo, ".serena"));
    expect(serenaProjectConfigProblem(repo)).toMatch(/project-controlled/);
    rmSync(repo, { recursive: true, force: true });
  });

  it("generates read-only Serena config only for staged languages present in the checkout", async () => {
    const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "leveret-serena-project-"));
    const repo = join(root, "repo");
    const home = join(root, "home");
    mkdirSync(repo);
    mkdirSync(home);
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(home, "leveret-lsp-manifest.json"), '{"languages":["php","python","rust"]}\n');
    writeFileSync(join(repo, "composer.json"), "{}\n");
    writeFileSync(join(repo, "plugin.inc"), "<?php function plugin() {}\n");
    writeFileSync(join(repo, "lib.rs"), "pub fn value() {}\n");
    writeFileSync(join(repo, "node_modules", "ignored.py"), "value = 1\n");
    try {
      expect(await prepareSerenaProject(repo, home)).toEqual(["php", "rust"]);
      const config = readFileSync(join(repo, ".serena", "project.yml"), "utf8");
      expect(config).toContain("read_only: true");
      expect(config).toContain('file_filter:');
      expect(config).toContain('  - .inc');
      expect(config).not.toContain("python");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stages fixtures into a fixed Serena home without retaining project registrations", async () => {
    const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "leveret-prefetch-test-"));
    const home = join(root, "serena-home");
    const fake = join(root, "serena-fake");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    chmodSync(fake, 0o755);
    try {
      await prefetchSerena({ home, languages: ["typescript"], serenaBin: fake });
      const manifest = JSON.parse(readFileSync(join(home, "leveret-lsp-manifest.json"), "utf8"));
      expect(manifest.languages).toEqual(["typescript"]);
      const config = readFileSync(join(home, "serena_config.yml"), "utf8");
      expect(config).toContain("web_dashboard: false");
      expect(config).toMatch(/projects:\s*\[\]/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
