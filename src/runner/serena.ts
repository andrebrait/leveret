import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { stringify } from "yaml";
import { safeChildEnvironment } from "../exec.js";

export interface SerenaFixture {
  language: string;
  files: Array<{ path: string; content: string }>;
}

const FIXTURES: SerenaFixture[] = [
  { language: "typescript", files: [{ path: "package.json", content: '{"name":"fixture"}\n' }, { path: "index.ts", content: "export const value = 1;\n" }] },
  { language: "python", files: [{ path: "pyproject.toml", content: "[project]\nname='fixture'\nversion='0'\n" }, { path: "main.py", content: "value = 1\n" }] },
  { language: "php", files: [{ path: "composer.json", content: '{"name":"leveret/fixture"}\n' }, { path: "index.php", content: "<?php function value(): int { return 1; }\n" }] },
  { language: "bash", files: [{ path: "main.sh", content: "#!/bin/sh\nvalue=1\n" }] },
  { language: "yaml", files: [{ path: "config.yml", content: "value: 1\n" }] },
  { language: "json", files: [{ path: "config.json", content: '{"value":1}\n' }] },
  { language: "cpp", files: [{ path: "CMakeLists.txt", content: "cmake_minimum_required(VERSION 3.20)\nproject(fixture)\n" }, { path: "main.cpp", content: "int value() { return 1; }\n" }] },
  { language: "go", files: [{ path: "go.mod", content: "module example.test/fixture\n\ngo 1.24\n" }, { path: "main.go", content: "package fixture\nfunc Value() int { return 1 }\n" }] },
  { language: "rust", files: [{ path: "Cargo.toml", content: "[package]\nname='fixture'\nversion='0.1.0'\nedition='2024'\n" }, { path: "src/lib.rs", content: "pub fn value() -> i32 { 1 }\n" }] },
  { language: "java", files: [{ path: "pom.xml", content: "<project><modelVersion>4.0.0</modelVersion><groupId>test</groupId><artifactId>fixture</artifactId><version>1</version></project>\n" }, { path: "src/main/java/Fixture.java", content: "final class Fixture { static int value() { return 1; } }\n" }] },
];

export function serenaPrefetchFixtures(): SerenaFixture[] {
  return FIXTURES.map((fixture) => ({ ...fixture, files: fixture.files.map((file) => ({ ...file })) }));
}

export function buildSerenaArgs(repo: string): string[] {
  return [
    "start-mcp-server",
    "--project",
    repo,
    "--transport",
    "stdio",
    "--enable-web-dashboard",
    "false",
    "--enable-gui-log-window",
    "false",
    "--open-web-dashboard",
    "false",
  ];
}

export function safeToolEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries({
    ...safeChildEnvironment(source),
    ...(source.SERENA_HOME ? { SERENA_HOME: source.SERENA_HOME } : {}),
    SERENA_USAGE_REPORTING: "false",
    UV_OFFLINE: "1",
    PIP_NO_INDEX: "1",
    npm_config_offline: "true",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
  }).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

export function serenaBundleProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.LEVERET_ALLOW_UNPACKAGED_SERENA === "1") return null;
  if (!env.SERENA_HOME) return "SERENA_HOME is unset; no packaged LSP bundle is available";
  if (!existsSync(join(env.SERENA_HOME, "leveret-lsp-manifest.json"))) {
    return `no staged Leveret LSP manifest in ${env.SERENA_HOME}`;
  }
  return null;
}

export function serenaProjectConfigProblem(repo: string): string | null {
  return existsSync(join(repo, ".serena"))
    ? "reviewed checkout contains .serena configuration; refusing project-controlled Serena settings"
    : null;
}

const LANGUAGE_EXTENSIONS: Record<string, Set<string>> = {
  typescript: new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]),
  python: new Set([".py", ".pyi"]),
  php: new Set([".php", ".phtml"]),
  bash: new Set([".sh", ".bash"]),
  yaml: new Set([".yaml", ".yml"]),
  json: new Set([".json", ".jsonc"]),
  cpp: new Set([".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".m", ".mm"]),
  go: new Set([".go"]),
  rust: new Set([".rs"]),
  java: new Set([".java"]),
};

const SKIP_DIRS = new Set([".git", ".serena", "node_modules", "vendor", "dist", "build", "target", ".venv"]);

async function detectedLanguages(repo: string, staged: Set<string>): Promise<string[]> {
  const found = new Set<string>();
  const stack = [repo];
  let visited = 0;
  while (stack.length && found.size < staged.size && visited < 20_000) {
    const dir = stack.pop()!;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++visited >= 20_000) break;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
        continue;
      }
      const extension = extname(entry.name).toLowerCase();
      for (const language of staged) {
        if (LANGUAGE_EXTENSIONS[language]?.has(extension)) found.add(language);
      }
    }
  }
  if (staged.has("php") && existsSync(join(repo, "composer.json"))) {
    // .inc is generic; only a PHP project opts it into Intelephense.
    const hasInc = await hasExtension(repo, ".inc");
    if (hasInc) found.add("php");
  }
  return [...found].sort((a, b) => serenaPrefetchFixtures().findIndex((f) => f.language === a) - serenaPrefetchFixtures().findIndex((f) => f.language === b));
}

async function hasExtension(repo: string, wanted: string): Promise<boolean> {
  const stack = [repo];
  let visited = 0;
  while (stack.length && visited < 20_000) {
    const dir = stack.pop()!;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++visited >= 20_000) return false;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
      } else if (extname(entry.name).toLowerCase() === wanted) return true;
    }
  }
  return false;
}

export async function prepareSerenaProject(repo: string, home: string): Promise<string[]> {
  const configProblem = serenaProjectConfigProblem(repo);
  if (configProblem) throw new Error(configProblem);
  const manifest = JSON.parse(await readFile(join(home, "leveret-lsp-manifest.json"), "utf8")) as { languages?: unknown };
  if (!Array.isArray(manifest.languages) || !manifest.languages.every((language) => typeof language === "string")) {
    throw new Error("invalid Leveret LSP manifest");
  }
  const languages = await detectedLanguages(repo, new Set(manifest.languages));
  const projectDir = join(repo, ".serena");
  await mkdir(projectDir);
  await writeFile(
    join(projectDir, "project.yml"),
    stringify({
      project_name: `leveret-${basename(repo)}`,
      language_servers: languages,
      encoding: "utf-8",
      ignored_paths: [".git/**", "node_modules/**", "vendor/**", "dist/**", "build/**", "target/**", ".venv/**"],
      read_only: true,
      ...(languages.includes("php") ? { ls_specific_settings: { php: { file_filter: [".inc"] } } } : {}),
    }),
  );
  return languages;
}

const READ_ONLY_TOOLS = new Set([
  "find_declaration",
  "find_implementations",
  "find_referencing_symbols",
  "find_symbol",
  "get_diagnostics_for_file",
  "get_symbols_overview",
]);

function textContent(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return JSON.stringify(result);
  return result.content
    .map((item) => {
      if (item && typeof item === "object" && "text" in item && typeof item.text === "string") return item.text;
      return JSON.stringify(item);
    })
    .join("\n");
}

export interface SerenaBridge {
  tools: ToolDefinition[];
  close(): Promise<void>;
  version?: string;
  pid?: number;
}

export async function connectSerena(repo: string, command = "serena", timeoutMs = 120_000): Promise<SerenaBridge> {
  const generatedProjectDir = join(repo, ".serena");
  const home = process.env.SERENA_HOME;
  if (!home) throw new Error("SERENA_HOME is required for packaged Serena");
  const languages = await prepareSerenaProject(repo, home);
  if (languages.length === 0) {
    return {
      tools: [],
      close: async () => {
        await rm(generatedProjectDir, { recursive: true, force: true });
      },
    };
  }
  const transport = new StdioClientTransport({
    command,
    args: buildSerenaArgs(repo),
    cwd: repo,
    env: safeToolEnvironment(),
    stderr: "pipe",
    maxBufferSize: 16 * 1024 * 1024,
  });
  const client = new Client({ name: "leveret-runner-pi", version: "0.1.0" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Serena startup exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    const listed = await client.listTools();
    const tools: ToolDefinition[] = listed.tools
      .filter((tool) => READ_ONLY_TOOLS.has(tool.name))
      .map((tool) => ({
        name: `lsp_${tool.name}`,
        label: `LSP ${tool.name}`,
        description: tool.description ?? `Serena ${tool.name}`,
        parameters: tool.inputSchema as TSchema,
        async execute(_toolCallId, params) {
          const result = await client.callTool({ name: tool.name, arguments: params as Record<string, unknown> });
          return {
            content: [{ type: "text" as const, text: textContent(result) }],
            details: { server: "serena", tool: tool.name, isError: result.isError === true },
          };
        },
      }));
    return {
      tools,
      version: client.getServerVersion()?.version,
      pid: transport.pid ?? undefined,
      close: async () => {
        await client.close();
        await rm(generatedProjectDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await transport.close().catch(() => {});
    await rm(generatedProjectDir, { recursive: true, force: true });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
