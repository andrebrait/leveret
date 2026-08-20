import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { scan } from "../src/scan.js";

// Custom engines: any command that emits SARIF on stdout plugs in through the
// profile alone — no leveret code per tool. Proven with a stub emitter.

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "leveret-custom-"));
  writeFileSync(join(repo, "Dockerfile"), "FROM ubuntu:latest\n");
  writeFileSync(join(repo, "other.txt"), "hi\n");
  const sarif = {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "stublint" } },
        results: [
          {
            ruleId: "DL3007",
            level: "warning",
            message: { text: "Using latest is prone to errors" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "Dockerfile" },
                  region: { startLine: 1 },
                },
              },
            ],
          },
        ],
      },
    ],
  };
  const stub = join(repo, "stublint.sh");
  writeFileSync(stub, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(sarif)}\nEOF\n`);
  chmodSync(stub, 0o755);
  writeFileSync(
    join(repo, ".leveret.yml"),
    `custom:
  - id: stublint
    command: ["./stublint.sh"]
    files: ["**/Dockerfile*"]
`,
  );
});

describe("custom SARIF engines", () => {
  it("a profile-declared SARIF command surfaces normalized findings", async () => {
    const result = await scan({ repo, files: ["Dockerfile"] });
    const finding = result.findings.find((f) => f.engine === "stublint");
    expect(finding).toMatchObject({
      rule: "DL3007",
      severity: "warning",
      file: "Dockerfile",
      line: 1,
      message: "Using latest is prone to errors",
    });
    expect(result.engines.find((e) => e.engine === "stublint")?.status).toBe("findings");
  });

  it("file globs gate the custom engine like any other", async () => {
    const result = await scan({ repo, files: ["other.txt"] });
    expect(result.engines.find((e) => e.engine === "stublint")?.status).toBe("not-applicable");
  });

  it("a custom entry without id/command/files is a config error", async () => {
    const bad = join(tmpdir(), `leveret-badcustom-${process.pid}.yml`);
    writeFileSync(bad, 'custom:\n  - id: broken\n    files: ["**"]\n');
    await expect(scan({ repo, files: ["Dockerfile"], profilePath: bad })).rejects.toThrow(
      /command/,
    );
  });
});
