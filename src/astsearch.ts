import { run } from "./exec.js";

export interface AstMatch {
  file: string;
  line: number;
  endLine: number;
  text: string;
}

export async function astSearch(opts: {
  repo: string;
  pattern: string;
  lang: string;
  paths?: string[];
}): Promise<AstMatch[]> {
  const args = ["run", "--pattern", opts.pattern, "--lang", opts.lang, "--json=stream"];
  const r = await run("ast-grep", [...args, ...(opts.paths ?? ["."])], opts.repo);
  if (r.code === -1) throw new Error("ast-grep not on PATH");
  const matches: AstMatch[] = [];
  for (const linetxt of r.stdout.split("\n")) {
    if (!linetxt.trim()) continue;
    const m = JSON.parse(linetxt) as {
      file: string;
      range: { start: { line: number }; end: { line: number } };
      text: string;
    };
    matches.push({
      file: m.file,
      line: m.range.start.line + 1, // ast-grep ranges are 0-based
      endLine: m.range.end.line + 1,
      text: m.text,
    });
  }
  return matches;
}
