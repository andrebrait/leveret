// Incremental re-review: on a new push, the bot re-judges its OWN previous
// findings against the new head, resolves the fixed threads with a short reply,
// and reports the ledger — the same previous-review discipline a careful human
// reviewer follows, and the courtesy CodeRabbit users expect.

export interface PriorFinding {
  threadId: string;
  path: string;
  line: number | null;
  excerpt: string;
  /** numeric id of the thread's first comment, for REST replies */
  commentId?: number;
}

interface ThreadsResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: {
            id: string;
            isResolved: boolean;
            path: string | null;
            line: number | null;
            comments?: { nodes?: { databaseId?: number; author?: { login?: string } | null; body?: string }[] };
          }[];
        };
      };
    };
  };
}

/** The bot's own UNRESOLVED threads: those are the findings a new push answers.
 * GraphQL spells a Bot login without the [bot] suffix REST uses — this exact
 * mismatch silently emptied the prior list on the first live incremental run,
 * so both sides are normalized before comparing. */
const bare = (login: string) => login.replace(/\[bot\]$/, "");

export function parsePriorThreads(res: ThreadsResponse, botLogin: string): PriorFinding[] {
  const nodes = res.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const out: PriorFinding[] = [];
  for (const t of nodes) {
    if (t.isResolved) continue;
    const first = t.comments?.nodes?.[0];
    if (!first || bare(first.author?.login ?? "") !== bare(botLogin)) continue;
    out.push({
      threadId: t.id,
      path: t.path ?? "",
      line: t.line,
      excerpt: (first.body ?? "").slice(0, 400),
      ...(first.databaseId ? { commentId: first.databaseId } : {}),
    });
  }
  return out;
}

export interface Resolution {
  threadId: string;
  status: "resolved" | "still-open";
  note: string;
}

export function resolvedReply(note: string, headSha: string): string {
  return `🐇 Verified at \`${headSha.slice(0, 7)}\`: ${note} — resolving.`;
}

export function renderResolutions(resolutions: Resolution[]): string {
  if (resolutions.length === 0) return "";
  const resolved = resolutions.filter((r) => r.status === "resolved");
  const open = resolutions.filter((r) => r.status === "still-open");
  const s: string[] = [
    "### Previously raised",
    "",
    `${resolved.length} resolved, ${open.length} still open.`,
    "",
  ];
  for (const r of open) s.push(`- still open: ${r.note}`);
  return s.join("\n");
}
