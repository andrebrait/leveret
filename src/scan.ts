import { join } from "node:path";
import { ENGINES, which, type ScanContext } from "./engines/registry.js";
import { run } from "./exec.js";
import type { EngineReport, Finding, ScanResult } from "./findings.js";
import { applyMemory } from "./memory.js";
import { filterFindings, loadProfile, scopeFiles } from "./profile.js";

export async function changedFiles(repo: string, base: string): Promise<string[]> {
  // ACMR: deletions have nothing to scan. -z survives any file name.
  const r = await run(
    "git",
    ["diff", "--name-only", "-z", "--diff-filter=ACMR", `${base}...HEAD`],
    repo,
  );
  if (r.code !== 0) throw new Error(`git diff failed: ${r.stderr.slice(0, 500)}`);
  return r.stdout.split("\0").filter(Boolean);
}

export async function scan(opts: {
  repo: string;
  base?: string;
  files?: string[];
  engines?: string[];
  profilePath?: string;
}): Promise<ScanResult> {
  const files = opts.files ?? (opts.base ? await changedFiles(opts.repo, opts.base) : []);
  if (files.length === 0 && !opts.files) {
    throw new Error("scan needs either files[] or a base ref with changes");
  }
  const profile = await loadProfile(opts.profilePath ?? join(opts.repo, ".leveret.yml"));
  const ctx: ScanContext = { repo: opts.repo, files, base: opts.base };
  const wanted = ENGINES.filter((e) => !opts.engines || opts.engines.includes(e.id));

  const findings: Finding[] = [];
  const reports: EngineReport[] = [];
  await Promise.all(
    wanted.map(async (engine) => {
      const selected = scopeFiles(profile, engine.id, engine.select(ctx));
      if (selected.length === 0) {
        reports.push({ engine: engine.id, status: "not-applicable" });
        return;
      }
      if (!(await which(engine.bin))) {
        reports.push({ engine: engine.id, status: "missing", detail: `${engine.bin} not on PATH` });
        return;
      }
      try {
        const found = await engine.scan(ctx, selected);
        findings.push(...found);
        reports.push({ engine: engine.id, status: found.length > 0 ? "findings" : "clean" });
      } catch (err) {
        reports.push({ engine: engine.id, status: "error", detail: String(err).slice(0, 500) });
      }
    }),
  );
  const { kept: afterProfile, suppressed: byProfile } = filterFindings(profile, findings);
  const { kept, suppressed: byMemory } = await applyMemory(opts.repo, afterProfile);
  const suppressed = [...byProfile, ...byMemory].sort((a, b) => a.rule.localeCompare(b.rule));
  kept.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  reports.sort((a, b) => a.engine.localeCompare(b.engine));
  return { findings: kept, engines: reports, suppressed };
}
