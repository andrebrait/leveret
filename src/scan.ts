import { existsSync, realpathSync } from "node:fs";
import { join, matchesGlob, resolve } from "node:path";
import { parseSarif } from "./sarif.js";
import { baseFindingKeys, findingKey } from "./delta.js";
import { ENGINES, which, type Engine, type ScanContext } from "./engines/registry.js";
import { run } from "./exec.js";
import type { EngineReport, Finding, ScanResult } from "./findings.js";
import { applyMemory } from "./memory.js";
import { filterFindings, loadProfile, scopeFiles, type Profile } from "./profile.js";

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

/** Run every applicable engine over one tree. The single engine-execution path —
 * the head scan and the delta base scan both go through here. */
async function runEngines(
  ctx: ScanContext,
  profile: Profile,
  wanted: Engine[],
  reports?: EngineReport[],
): Promise<Finding[]> {
  const findings: Finding[] = [];
  await Promise.all(
    wanted.map(async (engine) => {
      // Rule packs resolve against the head repo: a base tree may predate them.
      const engineProfile = profile.engines[engine.id];
      const rules = engineProfile?.rules?.map((r) => resolve(ctx.repo, r));
      const ectx: ScanContext = { ...ctx, rules, engineProfile };
      const selected = scopeFiles(profile, engine.id, engine.select(ectx));
      if (selected.length === 0) {
        reports?.push({ engine: engine.id, status: "not-applicable" });
        return;
      }
      // custom engines may name a repo-local script rather than a PATH binary
      if (!(await which(engine.bin)) && !existsSync(join(ctx.repo, engine.bin))) {
        reports?.push({ engine: engine.id, status: "missing", detail: `${engine.bin} not on PATH` });
        return;
      }
      try {
        const found = await engine.scan(ectx, selected);
        // Some engines (ruff) echo absolute paths — and resolve symlinks while at
        // it (macOS /var vs /private/var). Identity across trees needs
        // repo-relative files, so strip both spellings of the repo root here.
        const roots = [ctx.repo, realpathSync(ctx.repo)];
        for (const f of found) {
          for (const root of roots) {
            if (f.file.startsWith(`${root}/`)) f.file = f.file.slice(root.length + 1);
          }
        }
        findings.push(...found);
        // Status is finalized post-filter in scan(): an engine whose findings all
        // get dropped by delta/profile/memory must not read as "findings".
        reports?.push({
          engine: engine.id,
          status: found.length > 0 ? "findings" : "clean",
          found: found.length,
          kept: found.length,
        });
      } catch (err) {
        reports?.push({ engine: engine.id, status: "error", detail: String(err).slice(0, 500) });
      }
    }),
  );
  return findings;
}

export async function scan(opts: {
  repo: string;
  base?: string;
  files?: string[];
  engines?: string[];
  profilePath?: string;
  /** with a base: drop findings already present at the base tree (default true) */
  delta?: boolean;
}): Promise<ScanResult> {
  const files = opts.files ?? (opts.base ? await changedFiles(opts.repo, opts.base) : []);
  if (files.length === 0 && !opts.files) {
    throw new Error("scan needs either files[] or a base ref with changes");
  }
  const profile = await loadProfile(
    opts.profilePath ? resolve(opts.profilePath) : join(opts.repo, ".leveret.yml"),
  );
  const custom: Engine[] = profile.custom.map((def) => ({
    id: def.id,
    bin: def.command[0]!,
    select: (ctx) => ctx.files.filter((f) => def.files.some((g) => matchesGlob(f, g))),
    scan: async (ctx, selected) => {
      const r = await run(def.command[0]!, [...def.command.slice(1), ...selected], ctx.repo);
      return parseSarif(def.id, r.stdout);
    },
  }));
  const wanted = [...ENGINES, ...custom].filter(
    (e) => !opts.engines || opts.engines.includes(e.id),
  );

  const reports: EngineReport[] = [];
  const findings = await runEngines({ repo: opts.repo, files, base: opts.base }, profile, wanted, reports);

  // Delta: everything the base tree already produced is pre-existing. Range engines
  // (gitleaks) are inherently delta and deselect themselves without a base.
  let preExisting = 0;
  if (opts.base) {
    const baseKeys = await baseFindingKeys(opts.repo, opts.base, (baseRepo) =>
      runEngines(
        { repo: baseRepo, files: files.filter((f) => existsSync(join(baseRepo, f))) },
        profile,
        wanted,
      ),
    );
    for (const f of findings) {
      f.provenance = baseKeys.has(await findingKey(opts.repo, f)) ? "pre-existing" : "introduced";
    }
    if (opts.delta !== false) {
      preExisting = findings.filter((f) => f.provenance === "pre-existing").length;
      findings.splice(0, findings.length, ...findings.filter((f) => f.provenance === "introduced"));
    }
  } else {
    for (const f of findings) f.provenance = "introduced";
  }

  const { kept: afterProfile, suppressed: byProfile } = filterFindings(profile, findings);
  const { kept, suppressed: byMemory } = await applyMemory(opts.repo, afterProfile);
  const suppressed = [...byProfile, ...byMemory].sort((a, b) => a.rule.localeCompare(b.rule));
  kept.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  for (const r of reports) {
    if (r.found === undefined) continue; // not-applicable / missing / error ran nothing
    r.kept = kept.filter((f) => f.engine === r.engine).length;
    r.status = r.kept > 0 ? "findings" : r.found > 0 ? "filtered" : "clean";
  }
  reports.sort((a, b) => a.engine.localeCompare(b.engine));
  return { findings: kept, engines: reports, suppressed, preExisting };
}
