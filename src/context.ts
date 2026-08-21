import { run, which } from "./exec.js";

// Prioritization context for the review agent: not findings, signal. A function
// with high complexity in a file churned thirty times this year deserves the
// deepest read; a one-line change in a stable leaf does not.

export interface FunctionInfo {
  name: string;
  line: number;
  endLine: number;
  ccn: number;
  nloc: number;
}

export interface FileContext {
  file: string;
  /** commits touching this file in the trailing 12 months; null if git failed */
  churn: number | null;
  /** date of the last commit touching it, or null for untracked files */
  lastTouched: string | null;
  /** null when complexity could not be measured — a missing tool must not read
   * as "zero-complexity stable code" and invert the prioritization signal */
  functions: FunctionInfo[] | null;
  /** set when a backing tool was missing or failed */
  error?: string;
}

// lizard --csv: nloc,ccn,tokens,params,length,"name@start-end@file",file,name,long_name,start,end
function parseLizard(csv: string): Map<string, FunctionInfo[]> {
  const byFile = new Map<string, FunctionInfo[]>();
  for (const line of csv.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^(\d+),(\d+),\d+,\d+,\d+,"[^"]*",("?)(.*?)\3,("?)(.*?)\5,"?.*?"?,(\d+),(\d+)$/);
    if (!m) continue;
    const [, nloc, ccn, , file, , name, start, end] = m;
    const list = byFile.get(file!) ?? [];
    list.push({
      name: name!,
      line: Number(start),
      endLine: Number(end),
      ccn: Number(ccn),
      nloc: Number(nloc),
    });
    byFile.set(file!, list);
  }
  return byFile;
}

export async function context(opts: { repo: string; files: string[] }): Promise<FileContext[]> {
  let functions: Map<string, FunctionInfo[]> | null = null;
  let lizardError: string | undefined;
  if (!(await which("lizard"))) {
    lizardError = "lizard not on PATH: complexity unavailable";
  } else {
    const lizard = await run("lizard", ["--csv", ...opts.files], opts.repo);
    if (lizard.code === 0) {
      functions = parseLizard(lizard.stdout);
    } else {
      lizardError = `lizard rc=${lizard.code}: ${lizard.stderr.slice(0, 200)}`;
    }
  }

  const out: FileContext[] = [];
  for (const file of opts.files) {
    const log = await run(
      "git",
      ["log", "--since=12 months ago", "--follow", "--format=%cs", "--", file],
      opts.repo,
    );
    const gitOk = log.code === 0;
    const dates = gitOk ? log.stdout.split("\n").filter(Boolean) : [];
    out.push({
      file,
      churn: gitOk ? dates.length : null,
      lastTouched: dates[0] ?? null,
      functions: functions ? (functions.get(file) ?? []) : null,
      ...(lizardError || !gitOk
        ? { error: [lizardError, gitOk ? null : `git log rc=${log.code}`].filter(Boolean).join("; ") }
        : {}),
    });
  }
  return out;
}
