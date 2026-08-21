import { App } from "octokit";
import type { InlineComment } from "./render.js";

// Thin GitHub App client: everything interesting happens in render/webhook/runner;
// this file only moves bytes to the API.

export interface AppAuth {
  appId: string;
  privateKey: string;
}

export function makeApp(auth: AppAuth): App {
  return new App({ appId: auth.appId, privateKey: auth.privateKey });
}

/** One review submission: walkthrough as the review body, findings as inline
 * comments. Inline anchors can fail (file renamed since head, line outside the
 * diff); GitHub rejects the whole review then, so retry once without inline
 * comments rather than losing the walkthrough. */
export async function postReview(
  app: App,
  installationId: number,
  repo: string,
  pr: number,
  headSha: string,
  walkthrough: string,
  inline: InlineComment[],
): Promise<void> {
  const octokit = await app.getInstallationOctokit(installationId);
  const [owner, name] = repo.split("/") as [string, string];
  const base = {
    owner,
    repo: name,
    pull_number: pr,
    commit_id: headSha,
    event: "COMMENT" as const,
    body: walkthrough,
  };
  try {
    await octokit.rest.pulls.createReview({
      ...base,
      comments: inline.map((c) => ({ path: c.path, line: c.line, side: "RIGHT" as const, body: c.body })),
    });
  } catch {
    await octokit.rest.pulls.createReview(base);
  }
}
