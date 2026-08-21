import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildManifest,
  loadCredentials,
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
