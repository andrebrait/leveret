import { describe, expect, it } from "vitest";
import { parsePriorThreads, resolvedReply, renderResolutions } from "../src/app/incremental.js";
import { loadContract } from "../src/prompts.js";

// Incremental re-review: on a new push the bot re-judges its OWN previous
// findings, resolves the fixed ones (with a short reply), and reports the ledger.

const gql = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [
            {
              id: "T1",
              isResolved: false,
              path: "src/util/retry.ts",
              line: 11,
              comments: { nodes: [{ author: { login: "andrebrait-s-leveret[bot]" }, body: "**[major]** attempts option permits one extra invocation" }] },
            },
            {
              id: "T2",
              isResolved: true,
              path: "a.ts",
              line: 1,
              comments: { nodes: [{ author: { login: "andrebrait-s-leveret[bot]" }, body: "old resolved thing" }] },
            },
            {
              id: "T3",
              isResolved: false,
              path: "b.ts",
              line: 2,
              comments: { nodes: [{ author: { login: "someone-else" }, body: "human thread" }] },
            },
          ],
        },
      },
    },
  },
};

describe("parsePriorThreads", () => {
  it("matches the bot across REST and GraphQL login spellings — GraphQL omits [bot]", () => {
    const graphqlStyle = JSON.parse(JSON.stringify(gql));
    graphqlStyle.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes[0].author.login = "andrebrait-s-leveret";
    const prior = parsePriorThreads(graphqlStyle, "andrebrait-s-leveret[bot]");
    expect(prior).toHaveLength(1);
    expect(prior[0]!.threadId).toBe("T1");
  });

  it("keeps only the bot's own unresolved threads", () => {
    const prior = parsePriorThreads(gql, "andrebrait-s-leveret[bot]");
    expect(prior).toHaveLength(1);
    expect(prior[0]).toMatchObject({ threadId: "T1", path: "src/util/retry.ts", line: 11 });
    expect(prior[0]!.excerpt).toContain("one extra invocation");
  });
});

describe("resolution messaging", () => {
  it("the thread reply is short, names the verdict and the head", () => {
    const msg = resolvedReply("verified fixed: attempts is now total invocations", "3b1618a");
    expect(msg).toMatch(/🐇/);
    expect(msg).toContain("3b1618a");
    expect(msg).toContain("attempts is now total invocations");
  });

  it("the walkthrough ledger accounts for every prior finding", () => {
    const md = renderResolutions([
      { threadId: "T1", status: "resolved", note: "fixed by validation" },
      { threadId: "T4", status: "still-open", note: "backoff still trails" },
    ]);
    expect(md).toMatch(/previously raised/i);
    expect(md).toContain("1 resolved");
    expect(md).toContain("1 still open");
    expect(md).toContain("backoff still trails");
  });
});

describe("contract carries the prior-findings duty", () => {
  it("verify.md instructs judging prior findings and emitting resolutions", async () => {
    const text = await loadContract("verify", { repo: "r", base: "b" });
    expect(text).toContain('"resolutions"');
    expect(text).toMatch(/previous(ly)? (raised|posted|review) findings/i);
    expect(text).toMatch(/"resolved"/);
    expect(text).toMatch(/"still-open"/);
  });
});
