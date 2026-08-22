import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { astSearch } from "../astsearch.js";
import { context } from "../context.js";
import { run, safeChildEnvironment } from "../exec.js";
import { learn, memoryList, remember } from "../memory.js";
import { scan } from "../scan.js";
import type { SerenaBridge } from "./serena.js";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }], details: {} };
}

function text(value: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: value }], details };
}

async function codegraph(repo: string, args: string[]): Promise<ReturnType<typeof text>> {
  const result = await run("codegraph", args, repo, {
    timeoutMs: 120_000,
    env: safeChildEnvironment(),
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.code !== 0) throw new Error(`codegraph ${args[0]} rc=${result.code}: ${result.stderr.slice(0, 500)}`);
  return text(result.stdout, { command: args[0] });
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export interface PiToolsOptions {
  repo: string;
  graphLive: boolean;
  sandboxed: boolean;
  serena?: SerenaBridge;
}

export interface PiToolsBundle {
  tools: ToolDefinition[];
  close(): Promise<void>;
  capabilities: { graph: boolean; lsp: boolean; probe: boolean; serena_version?: string };
}

export async function buildPiTools(options: PiToolsOptions): Promise<PiToolsBundle> {
  const { repo } = options;
  const tools: ToolDefinition[] = [
    defineTool({
      name: "leveret_scan",
      label: "Leveret scan",
      description: "Run Leveret's deterministic engines. Results are review leads, not verdicts.",
      parameters: Type.Object({
        base: Type.Optional(Type.String()),
        files: Type.Optional(Type.Array(Type.String())),
        engines: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_id, params) {
        return json(await scan({ repo, ...params }));
      },
    }),
    defineTool({
      name: "leveret_context",
      label: "Leveret context",
      description: "Return complexity, churn, and recency for prioritization; never treat it as a finding.",
      parameters: Type.Object({ files: Type.Array(Type.String()) }),
      async execute(_id, params) {
        return json(await context({ repo, files: params.files }));
      },
    }),
    defineTool({
      name: "leveret_ast_search",
      label: "Leveret AST search",
      description: "Find syntax-shaped occurrences with ast-grep. This does not establish dependency relationships.",
      parameters: Type.Object({
        pattern: Type.String(),
        lang: Type.String(),
        paths: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_id, params) {
        return json(await astSearch({ repo, ...params }));
      },
    }),
    defineTool({
      name: "leveret_memory",
      label: "Leveret memory",
      description: "List the reviewed repository's stored finding verdicts and human-taught conventions.",
      parameters: Type.Object({}),
      async execute() {
        return json(await memoryList({ repo }));
      },
    }),
    defineTool({
      name: "leveret_remember",
      label: "Leveret remember",
      description: "Persist a priced-noise or false-positive verdict with an auditable reason.",
      parameters: Type.Object({
        fp: Type.String(),
        grade: Type.Union([Type.Literal("priced-noise"), Type.Literal("false-positive")]),
        reason: Type.String(),
        author: Type.Optional(Type.String()),
        anchorFile: Type.Optional(Type.String()),
        anchorLine: Type.Optional(Type.Number({ minimum: 1 })),
      }),
      async execute(_id, params) {
        return json(await remember({ repo, ...params }));
      },
    }),
    defineTool({
      name: "leveret_learn",
      label: "Leveret learn",
      description: "Persist a human-authored repository convention. Never invent a human ruling.",
      parameters: Type.Object({
        text: Type.String(),
        author: Type.String(),
        scope: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_id, params) {
        return json(await learn({ repo, ...params }));
      },
    }),
  ];

  if (options.graphLive) {
    tools.push(
      defineTool({
        name: "codegraph_explore",
        label: "CodeGraph explore",
        description: "Return relevant symbols, source, and call paths for an architectural question.",
        parameters: Type.Object({ query: Type.String(), max_files: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })) }),
        async execute(_id, params) {
          return codegraph(repo, ["explore", "--path", repo, ...(params.max_files ? ["--max-files", String(params.max_files)] : []), params.query]);
        },
      }),
      defineTool({
        name: "codegraph_node",
        label: "CodeGraph node",
        description: "Return one symbol or file with its caller/callee or dependent trail.",
        parameters: Type.Object({ name: Type.String() }),
        async execute(_id, params) {
          return codegraph(repo, ["node", "--path", repo, params.name]);
        },
      }),
      defineTool({
        name: "codegraph_impact",
        label: "CodeGraph impact",
        description: "Traverse the impact radius of changing a symbol.",
        parameters: Type.Object({ symbol: Type.String(), depth: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })) }),
        async execute(_id, params) {
          return codegraph(repo, ["impact", "--path", repo, "--depth", String(params.depth ?? 2), params.symbol]);
        },
      }),
      defineTool({
        name: "codegraph_affected",
        label: "CodeGraph affected tests",
        description: "Find tests affected by the supplied changed files.",
        parameters: Type.Object({ files: Type.Array(Type.String()), depth: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })) }),
        async execute(_id, params) {
          return codegraph(repo, ["affected", "--path", repo, "--depth", String(params.depth ?? 5), ...params.files]);
        },
      }),
    );
  }

  if (options.serena) tools.push(...options.serena.tools);

  if (options.sandboxed) {
    tools.push(defineTool({
      name: "leveret_probe",
      label: "Bounded probe",
      description: "Execute one non-shell command inside the declared review sandbox. Output and time are capped.",
      parameters: Type.Object({
        command: Type.String(),
        args: Type.Optional(Type.Array(Type.String())),
        cwd: Type.Optional(Type.String()),
        timeout_ms: Type.Optional(Type.Number({ minimum: 1, maximum: 120_000 })),
      }),
      async execute(_id, params) {
        const cwd = resolve(repo, params.cwd ?? ".");
        if (!inside(repo, cwd)) throw new Error("probe cwd must stay inside the reviewed checkout");
        let command = params.command;
        if (command.includes("/") || command.includes("\\")) {
          command = resolve(cwd, command);
          if (!inside(repo, command)) throw new Error("probe command path must stay inside the reviewed checkout");
        }
        const result = await run(command, params.args ?? [], cwd, {
          timeoutMs: params.timeout_ms ?? 30_000,
          env: safeChildEnvironment(),
          maxBuffer: 1024 * 1024,
        });
        if (result.code !== 0) throw new Error(`probe rc=${result.code}: ${result.stderr.slice(0, 1000)}`);
        return text(result.stdout, { code: result.code, signal: result.signal });
      },
    }));
  }

  return {
    tools,
    capabilities: {
      graph: options.graphLive,
      lsp: Boolean(options.serena?.tools.length),
      probe: options.sandboxed,
      ...(options.serena?.version ? { serena_version: options.serena.version } : {}),
    },
    close: async () => {
      await options.serena?.close();
    },
  };
}
