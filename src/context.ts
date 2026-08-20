import { run } from "./exec.js";

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
  /** commits touching this file in the trailing 12 months */
  churn: number;
  /** date of the last commit touching it, or null for untracked files */
  lastTouched: string | null;
  functions: FunctionInfo[];
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
  const lizard = await run("lizard", ["--csv", ...opts.files], opts.repo);
  const functions = parseLizard(lizard.stdout);

  const out: FileContext[] = [];
  for (const file of opts.files) {
    const log = await run(
      "git",
      ["log", "--since=12 months ago", "--follow", "--format=%cs", "--", file],
      opts.repo,
    );
    const dates = log.stdout.split("\n").filter(Boolean);
    out.push({
      file,
      churn: dates.length,
      lastTouched: dates[0] ?? null,
      functions: functions.get(file) ?? [],
    });
  }
  return out;
}
