import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  brandName,
  page,
  publicHookProblem,
  restartCommand,
  renderConfiguredPage,
  buildManifest,
  loadCredentials,
  renderCallbackPage,
  renderSetupPage,
  saveCredentials,
} from "../src/app/manifest.js";

// One-click App creation via GitHub's manifest flow: the user owns the App, the
// webhook URL points at their server, and the credentials never leave their box.

describe("buildManifest", () => {
  it("pins the review permissions, events; webhook goes public, the browser redirect stays local", () => {
    // smee relays webhook POSTs only — a browser GET to a smee URL never reaches
    // the server, so the redirect must target the host the browser is already on.
    const m = buildManifest("https://smee.io/abc123", "http://127.0.0.1:8090");
    expect(m.hook_attributes.url).toBe("https://smee.io/abc123/");
    expect(m.redirect_url).toBe("http://127.0.0.1:8090/setup/callback");
    expect(m.default_permissions).toEqual({ pull_requests: "write", contents: "read" });
    expect(m.default_events).toEqual(["pull_request", "pull_request_review_comment"]);
    expect(m.public).toBe(false);
    expect(m.name).toMatch(/leveret/i);
    expect(m.description).toMatch(/leveret/i);
  });
});

describe("brandName", () => {
  it("keeps Leveret in front so the bot login stays branded, within GitHub's 34-char cap", () => {
    // "Leveret acme" lowercases and spaces-to-dashes into leveret-acme[bot]
    expect(brandName("acme")).toBe("Leveret acme");
    expect(brandName()).toBe("Leveret");
    expect(brandName("  spaced  ")).toBe("Leveret spaced");
    const long = brandName("a".repeat(60));
    expect(long.length).toBeLessThanOrEqual(34);
    expect(long.startsWith("Leveret ")).toBe(true);
  });
});

describe("page", () => {
  it("wraps every server surface in the logo's own palette", () => {
    const html = page("Some title", "<p>body</p>");
    expect(html).toContain("#1d1728"); // logo plate
    expect(html).toContain("#a7ec21"); // logo plus-eye, the accent
    expect(html).toContain("/assets/logo.svg");
    // the mark is the way home
    expect(html).toContain('<a href="https://leveret-dev.io"><img src="/assets/logo.svg"');
    expect(html).toContain("<title>Some title</title>");
    expect(html).toContain("<p>body</p>");
  });
});

describe("publicHookProblem", () => {
  it("catches the addresses GitHub refuses before the manifest is ever posted", () => {
    // GitHub answers a loopback hook with "Hook url is not supported because it
    // isn't reachable over the public Internet" — after the user has clicked.
    expect(publicHookProblem("http://127.0.0.1:8091")).toContain("127.0.0.1");
    expect(publicHookProblem("http://localhost:8090")).toBeTruthy();
    expect(publicHookProblem("http://[::1]:8090")).toBeTruthy();
    expect(publicHookProblem("http://10.0.0.5:8090")).toBeTruthy();
    expect(publicHookProblem("http://192.168.1.9:8090")).toBeTruthy();
    expect(publicHookProblem("http://172.20.3.4:8090")).toBeTruthy();
    expect(publicHookProblem("http://100.101.102.103:8090")).toBeTruthy(); // tailnet IP
    expect(publicHookProblem("http://fastbox.local:8090")).toBeTruthy();
    expect(publicHookProblem("https://smee.io/R001HO80pV347cZ")).toBeNull();
    expect(publicHookProblem("https://box.husky-bonito.ts.net")).toBeNull();
  });

  it("replaces the form with the fix instead of letting GitHub reject the manifest", () => {
    const html = renderSetupPage("http://127.0.0.1:8091", "http://127.0.0.1:8091", "st", undefined, {
      restartCommand: "RESTART-ME",
    });
    expect(html).toContain('<h2 class="center">Unreachable server</h2>');
    expect(html).toContain("<code>LEVERET_PUBLIC_URL</code> is not configured");
    expect(html).toContain("GitHub's Webhooks require a publicly-accessible endpoint");
    // "documentation" is the link, not a bare URL dumped in the sentence
    expect(html).toContain('<a href="https://github.com/leveret-dev/leveret/blob/main/docs/app.md#getting-started">documentation</a>');
    expect(html).toContain("tailscale funnel");
    expect(html).toContain("Then restart with a public URL set, run:");
    expect(html).toContain("<pre><code>RESTART-ME</code></pre>");
    expect(html).not.toContain("server's own address");
    expect(html).not.toContain('name="manifest"');
  });

  it("does not claim the variable is unset when it is set to an unreachable address", () => {
    const html = renderSetupPage("http://10.0.0.5:8090", "http://127.0.0.1:8090", "st", undefined, {
      publicUrlConfigured: true,
    });
    expect(html).toContain("10.0.0.5");
    expect(html).not.toContain("is not configured");
  });
});

describe("restartCommand", () => {
  it("restarts what is actually running: absolute script path, runner preserved", () => {
    // "node dist/app/server.js" only works from the repo root, and a restart that
    // drops LEVERET_RUNNER silently downgrades every review to deterministic-only.
    expect(restartCommand({}, ["/opt/node", "/srv/leveret/dist/app/server.js"])).toBe(
      "LEVERET_PUBLIC_URL=https://YOUR-PUBLIC-URL node /srv/leveret/dist/app/server.js",
    );
    expect(
      restartCommand({ LEVERET_RUNNER: "node /srv/leveret/dist/runner/omp.js" }, [
        "/opt/node",
        "/srv/leveret/dist/app/server.js",
      ]),
    ).toBe(
      "LEVERET_PUBLIC_URL=https://YOUR-PUBLIC-URL LEVERET_RUNNER='node /srv/leveret/dist/runner/omp.js' node /srv/leveret/dist/app/server.js",
    );
    expect(restartCommand({ LEVERET_RUNNER: "it's odd" }, ["/opt/node", "/s.js"])).toContain(
      "LEVERET_RUNNER='it'\\''s odd'",
    );
  });
});

describe("html escaping", () => {
  it("never reflects a hostile Host header into the page", () => {
    // only the configured branch echoes the URL back, so that is where it matters
    const html = renderSetupPage("http://x<script>alert(1)</script>.local", "http://127.0.0.1", "st", undefined, {
      publicUrlConfigured: true,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("configured page", () => {
  it("states the fact, then lists the exact files to delete by full path", () => {
    const html = renderConfiguredPage("/srv/leveret-data");
    expect(html).toContain("Server configured and working!");
    expect(html).toContain("To reconfigure this server, delete these files and reload:");
    expect(html).toContain("center");
    expect(html).toContain("<li><code>/srv/leveret-data/app-credentials.json</code></li>");
    expect(html).toContain("<li><code>/srv/leveret-data/app.pem</code></li>");
  });
});

describe("renderSetupPage", () => {
  it("posts the manifest to GitHub with a state token", () => {
    const html = renderSetupPage("https://leveret.example:8090", "http://127.0.0.1:8090", "state123");
    expect(html).toContain("https://github.com/settings/apps/new?state=state123");
    expect(html).toContain("name=\"manifest\"");
    // the manifest travels inside the form
    expect(html).toContain("leveret.example");
  });

  it("carries the brand: logo, an owner field that names the App, and the org prefill", () => {
    const html = renderSetupPage("https://leveret.example:8090", "http://127.0.0.1:8090", "st", "acme");
    expect(html).toContain("/assets/logo.svg");
    expect(html).toContain("#1d1728");
    // the avatar has to be uploaded by hand later, so the file is offered up front
    expect(html).toContain('href="/assets/logo.png" download');
    expect(html).toContain('name="owner"');
    expect(html).toContain('value="acme"');
    // pre-named for the org, not the bare name every other install also wants
    expect(html).toContain("Leveret acme");
    expect(html).toContain("https://github.com/organizations/acme/settings/apps/new?state=st");
  });
});

describe("renderCallbackPage", () => {
  it("sends the user to upload the avatar — the one brand surface a manifest cannot set", () => {
    const personal = renderCallbackPage("https://github.com/apps/leveret-acme");
    expect(personal).toContain("/assets/logo.png");
    expect(personal).toContain("https://github.com/settings/apps/leveret-acme");
    expect(personal).toContain("https://github.com/apps/leveret-acme/installations/new");
    const org = renderCallbackPage("https://github.com/apps/leveret-acme", "acme");
    expect(org).toContain("https://github.com/organizations/acme/settings/apps/leveret-acme");
  });
});

describe("credential store", () => {
  it("round-trips and env vars win over the stored file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lev-creds-"));
    await saveCredentials(dir, { appId: "77", pem: "PEMDATA", webhookSecret: "s3cr3t" });
    const fromFile = await loadCredentials(dir, {});
    expect(fromFile).toMatchObject({ appId: "77", webhookSecret: "s3cr3t" });
    expect(fromFile!.privateKey).toBe("PEMDATA");
    const fromEnv = await loadCredentials(dir, {
      LEVERET_APP_ID: "88",
      LEVERET_PRIVATE_KEY_PATH: join(dir, "app.pem"),
      LEVERET_WEBHOOK_SECRET: "envsecret",
    });
    expect(fromEnv).toMatchObject({ appId: "88", webhookSecret: "envsecret" });
  });

  it("returns null when nothing is configured — the server then serves setup mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lev-nocreds-"));
    expect(await loadCredentials(dir, {})).toBeNull();
  });
});
