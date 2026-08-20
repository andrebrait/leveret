import { run, which } from "../exec.js";
import type { Finding, Severity } from "../findings.js";

export interface ScanContext {
  repo: string;
  files: string[];
  /** git range base (e.g. "origin/devel"); only range-aware engines use it */
  base?: string;
  /** this engine's profile-declared rule packs (semgrep configs, ast-grep sgconfig) */
  rules?: string[];
}

export interface Engine {
  id: string;
  bin: string;
  /** files this engine wants; empty = not applicable (range engines may ignore files) */
  select(ctx: ScanContext): string[];
  scan(ctx: ScanContext, selected: string[]): Promise<Finding[]>;
}

const ext = (f: string) => f.slice(f.lastIndexOf(".") + 1).toLowerCase();
const byExt = (files: string[], exts: string[]) => files.filter((f) => exts.includes(ext(f)));

function sev(raw: string, map: Record<string, Severity>): Severity {
  return map[raw.toLowerCase()] ?? "warning";
}

const semgrep: Engine = {
  id: "semgrep",
  bin: "semgrep",
  select: (ctx) => byExt(ctx.files, ["php", "inc", "py", "sh", "js", "ts"]),
  async scan(ctx, selected) {
    const configs = new Set(["p/security-audit"]);
    for (const f of selected) {
      const e = ext(f);
      if (e === "php" || e === "inc") configs.add("p/php");
      if (e === "py") configs.add("p/python");
      if (e === "sh") configs.add("p/bash");
      if (e === "js" || e === "ts") configs.add("p/javascript");
    }
    const args = ["scan", "--json", "--metrics=off", "--quiet"];
    for (const c of configs) args.push("--config", c);
    for (const r of ctx.rules ?? []) args.push("--config", r);
    const r = await run("semgrep", [...args, ...selected], ctx.repo);
    const doc = JSON.parse(r.stdout) as {
      results: {
        check_id: string;
        path: string;
        start: { line: number };
        end: { line: number };
        extra: { severity: string; message: string; lines?: string };
      }[];
    };
    return doc.results.map((x) => ({
      engine: "semgrep",
      rule: x.check_id,
      severity: sev(x.extra.severity, { error: "error", warning: "warning", info: "info" }),
      file: x.path,
      line: x.start.line,
      endLine: x.end.line,
      message: x.extra.message,
      snippet: x.extra.lines,
    }));
  },
};

const shellcheck: Engine = {
  id: "shellcheck",
  bin: "shellcheck",
  select: (ctx) => byExt(ctx.files, ["sh"]),
  async scan(ctx, selected) {
    const r = await run("shellcheck", ["-f", "json", ...selected], ctx.repo);
    const doc = JSON.parse(r.stdout) as {
      file: string;
      line: number;
      endLine?: number;
      level: string;
      code: number;
      message: string;
    }[];
    return doc.map((x) => ({
      engine: "shellcheck",
      rule: `SC${x.code}`,
      severity: sev(x.level, { error: "error", warning: "warning", info: "info", style: "info" }),
      file: x.file,
      line: x.line,
      endLine: x.endLine,
      message: x.message,
    }));
  },
};

const ruff: Engine = {
  id: "ruff",
  bin: "ruff",
  select: (ctx) => byExt(ctx.files, ["py"]),
  async scan(ctx, selected) {
    const r = await run("ruff", ["check", "--output-format", "json", ...selected], ctx.repo);
    const doc = JSON.parse(r.stdout) as {
      code: string | null;
      message: string;
      filename: string;
      location: { row: number };
      end_location?: { row: number };
    }[];
    return doc.map((x) => ({
      engine: "ruff",
      rule: x.code ?? "ruff",
      severity: "warning" as Severity,
      file: x.filename,
      line: x.location.row,
      endLine: x.end_location?.row,
      message: x.message,
    }));
  },
};

const actionlint: Engine = {
  id: "actionlint",
  bin: "actionlint",
  select: (ctx) =>
    ctx.files.filter((f) => f.startsWith(".github/workflows/") && ["yml", "yaml"].includes(ext(f))),
  async scan(ctx, selected) {
    const r = await run("actionlint", ["-format", "{{json .}}", ...selected], ctx.repo);
    const doc = JSON.parse(r.stdout) as {
      message: string;
      filepath: string;
      line: number;
      kind: string;
    }[];
    return doc.map((x) => ({
      engine: "actionlint",
      rule: x.kind,
      severity: "error" as Severity,
      file: x.filepath,
      line: x.line,
      message: x.message,
    }));
  },
};

const gitleaks: Engine = {
  id: "gitleaks",
  bin: "gitleaks",
  // Range engine: scans commits base..HEAD, so any non-empty change set applies.
  select: (ctx) => (ctx.base && ctx.files.length > 0 ? ctx.files : []),
  async scan(ctx) {
    const report = `${process.env.TMPDIR ?? "/tmp"}/leveret-gitleaks-${process.pid}.json`;
    const r = await run(
      "gitleaks",
      [
        "git",
        `--log-opts=${ctx.base}..HEAD`,
        "--no-banner",
        "--redact",
        "--exit-code",
        "0",
        "--report-format",
        "json",
        "--report-path",
        report,
        ".",
      ],
      ctx.repo,
    );
    if (r.code !== 0) throw new Error(`gitleaks rc=${r.code}: ${r.stderr.slice(0, 500)}`);
    const { readFile, unlink } = await import("node:fs/promises");
    const doc = JSON.parse(await readFile(report, "utf8")) as {
      RuleID: string;
      File: string;
      StartLine: number;
      EndLine: number;
      Description: string;
    }[];
    await unlink(report).catch(() => {});
    return doc.map((x) => ({
      engine: "gitleaks",
      rule: x.RuleID,
      severity: "error" as Severity,
      file: x.File,
      line: x.StartLine,
      endLine: x.EndLine,
      message: x.Description,
    }));
  },
};

const zizmor: Engine = {
  id: "zizmor",
  bin: "zizmor",
  select: (ctx) =>
    ctx.files.filter((f) => f.startsWith(".github/workflows/") && ["yml", "yaml"].includes(ext(f))),
  async scan(ctx, selected) {
    const r = await run("zizmor", ["--format", "json", ...selected], ctx.repo);
    const doc = JSON.parse(r.stdout) as {
      ident: string;
      desc: string;
      determinations: { severity: string };
      locations: {
        symbolic: {
          key: { Local?: { verbatim_path: string } };
          annotation?: string;
          kind: string;
        };
        concrete?: { location: { start_point: { row: number } } };
      }[];
    }[];
    return doc.map((x) => {
      const loc = x.locations.find((l) => l.symbolic.kind === "Primary") ?? x.locations[0];
      return {
        engine: "zizmor",
        rule: x.ident,
        severity: sev(x.determinations.severity, {
          high: "error",
          medium: "warning",
          low: "info",
          informational: "info",
          unknown: "warning",
        }),
        file: loc?.symbolic.key.Local?.verbatim_path ?? selected[0]!,
        line: (loc?.concrete?.location.start_point.row ?? 0) + 1, // rows are 0-based
        message: `${x.desc}${loc?.symbolic.annotation ? `: ${loc.symbolic.annotation}` : ""}`,
      };
    });
  },
};

const OSV_MANIFESTS = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "uv.lock",
  "poetry.lock",
  "requirements.txt",
  "composer.lock",
  "go.mod",
  "Cargo.lock",
  "Gemfile.lock",
]);

const osvScanner: Engine = {
  id: "osv-scanner",
  bin: "osv-scanner",
  select: (ctx) => ctx.files.filter((f) => OSV_MANIFESTS.has(f.split("/").pop() ?? "")),
  async scan(ctx, selected) {
    const args = ["scan", "--format", "json"];
    for (const f of selected) args.push("-L", f);
    const r = await run("osv-scanner", args, ctx.repo);
    const doc = JSON.parse(r.stdout) as {
      results?: {
        source: { path: string };
        packages: {
          package: { name: string; version: string };
          vulnerabilities: { id: string; summary?: string }[];
        }[];
      }[];
    };
    const findings = [];
    for (const res of doc.results ?? []) {
      // osv reports absolute source paths; findings stay repo-relative
      const file = res.source.path.startsWith(`${ctx.repo}/`)
        ? res.source.path.slice(ctx.repo.length + 1)
        : res.source.path;
      for (const p of res.packages) {
        for (const v of p.vulnerabilities) {
          findings.push({
            engine: "osv-scanner",
            rule: v.id,
            severity: "warning" as Severity,
            file,
            line: 1, // lockfiles have no meaningful line for a dependency
            message: `${p.package.name}@${p.package.version}: ${v.summary ?? v.id}`,
          });
        }
      }
    }
    return findings;
  },
};

const astGrep: Engine = {
  id: "ast-grep",
  bin: "ast-grep",
  // Runs only when the profile declares a rule pack; without one there is nothing to match.
  select: (ctx) => (ctx.rules?.length ? ctx.files : []),
  async scan(ctx, selected) {
    const findings = [];
    for (const config of ctx.rules ?? []) {
      const r = await run("ast-grep", ["scan", "--config", config, "--json", ...selected], ctx.repo);
      const doc = JSON.parse(r.stdout) as {
        ruleId: string;
        severity: string;
        message: string;
        file: string;
        lines: string;
        range: { start: { line: number }; end: { line: number } };
      }[];
      for (const x of doc) {
        findings.push({
          engine: "ast-grep",
          rule: x.ruleId,
          severity: sev(x.severity, { error: "error", warning: "warning", info: "info", hint: "info" }),
          file: x.file,
          line: x.range.start.line + 1, // lines are 0-based
          endLine: x.range.end.line + 1,
          message: x.message,
          snippet: x.lines,
        });
      }
    }
    return findings;
  },
};

export const ENGINES: Engine[] = [gitleaks, semgrep, shellcheck, ruff, actionlint, zizmor, osvScanner, astGrep];
export { which };
