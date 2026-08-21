import { createHmac, timingSafeEqual } from "node:crypto";

// GitHub webhook plumbing: signature verification and event → job routing.
// Pure; the HTTP server and API client wrap around this.

export function verifySignature(
  secret: string,
  body: string,
  header: string | undefined,
): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const got = header.slice("sha256=".length);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
}

export type Job =
  | {
      kind: "review";
      repo: string;
      pr: number;
      headSha: string;
      baseRef: string;
      cloneUrl: string;
      action: string;
      title: string;
      installationId?: number;
    }
  | {
      kind: "learn-feed";
      repo: string;
      pr: number;
      author: string;
      body: string;
      inReplyTo: number;
      installationId?: number;
    };

const REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

interface PullPayload {
  action?: string;
  pull_request?: {
    number: number;
    title?: string;
    head: { sha: string };
    base: { ref: string; repo: { full_name: string; clone_url: string } };
  };
  comment?: {
    id: number;
    user?: { login?: string; type?: string };
    body?: string;
    in_reply_to_id?: number;
  };
  installation?: { id: number };
}

export function routeEvent(event: string, payload: PullPayload): Job | null {
  if (event === "pull_request" && payload.action && REVIEW_ACTIONS.has(payload.action)) {
    const pr = payload.pull_request;
    if (!pr) return null;
    return {
      kind: "review",
      repo: pr.base.repo.full_name,
      pr: pr.number,
      headSha: pr.head.sha,
      baseRef: pr.base.ref,
      cloneUrl: pr.base.repo.clone_url,
      action: payload.action,
      title: pr.title ?? "",
      ...(payload.installation ? { installationId: payload.installation.id } : {}),
    };
  }
  if (event === "pull_request_review_comment" && payload.action === "created") {
    const c = payload.comment;
    const pr = payload.pull_request;
    // A human reply in a finding thread is the learn feed; bots never teach.
    if (!c || !pr || c.user?.type === "Bot" || !c.in_reply_to_id) return null;
    return {
      kind: "learn-feed",
      repo: pr.base.repo.full_name,
      pr: pr.number,
      author: c.user?.login ?? "unknown",
      body: c.body ?? "",
      inReplyTo: c.in_reply_to_id,
      ...(payload.installation ? { installationId: payload.installation.id } : {}),
    };
  }
  return null;
}
