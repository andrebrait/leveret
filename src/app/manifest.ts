import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// GitHub App Manifest flow: the CodeRabbit-grade one-click setup where the USER
// owns the App. Our server renders a form that posts a manifest to GitHub; GitHub
// creates the App under the user's account and redirects back with a one-time code
// we exchange for the credentials — which never leave the user's box.

export interface Manifest {
  name: string;
  description: string;
  url: string;
  hook_attributes: { url: string };
  redirect_url: string;
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
}

/** GitHub App names are unique ACROSS GitHub and capped at 34 characters, so a
 * self-hoster cannot register a second App called "Leveret". Branding survives as
 * the leading word instead: "Leveret acme" slugs to `leveret-acme`, and every
 * review the App posts is signed `leveret-acme[bot]`. */
export function brandName(owner?: string): string {
  return `Leveret ${(owner ?? "").trim()}`.trim().slice(0, 34);
}

export function buildManifest(hookUrl: string, redirectBase: string, name = brandName()): Manifest {
  // hookUrl is where GitHub DELIVERS WEBHOOKS (tunnel or smee channel);
  // redirectBase is where the USER'S BROWSER returns after creation — the browser
  // sits next to the server, so this stays local. smee relays webhook POSTs only:
  // using it for the redirect would strand the browser on smee's page.
  const hook = hookUrl.replace(/\/+$/, "");
  const redirect = redirectBase.replace(/\/+$/, "");
  return {
    name,
    description:
      "Leveret — self-hosted code review. The engine, the checkout and the model credentials stay on the owner's infrastructure; nothing about the reviewed code leaves it.",
    url: "https://github.com/andrebrait/leveret",
    hook_attributes: { url: `${hook}/` },
    redirect_url: `${redirect}/setup/callback`,
    public: false,
    default_permissions: { pull_requests: "write", contents: "read" },
    default_events: ["pull_request", "pull_request_review_comment"],
  };
}

const PAGE_HEAD = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1.5rem;
        line-height: 1.5; color: #1c1c1e; background: #fbfaf8; }
 img.logo { width: 8rem; display: block; margin: 0 auto 1rem; }
 h1 { text-align: center; font-weight: 650; margin: 0 0 .25rem; }
 p.tag { text-align: center; color: #6a6a70; margin: 0 0 2rem; }
 label { display: block; font-weight: 600; margin: 1.5rem 0 .35rem; }
 input[type=text] { width: 100%; padding: .55rem .7rem; font-size: 1rem; border: 1px solid #cfcbc4;
        border-radius: .4rem; box-sizing: border-box; }
 small { color: #6a6a70; display: block; margin-top: .4rem; }
 button { margin-top: 1.75rem; font-size: 1.05rem; font-weight: 600; padding: .65rem 1.5rem;
        border: 0; border-radius: .4rem; background: #3d9e6a; color: #fff; cursor: pointer; }
 ol { padding-left: 1.2rem; } li { margin: .6rem 0; }
</style>`;

export function renderSetupPage(
  hookUrl: string,
  redirectBase: string,
  state: string,
  org?: string,
): string {
  const manifest = JSON.stringify(buildManifest(hookUrl, redirectBase, brandName(org)));
  const action = org
    ? `https://github.com/organizations/${org}/settings/apps/new?state=${state}`
    : `https://github.com/settings/apps/new?state=${state}`;
  return `<!doctype html>
<html><head><title>Set up Leveret</title>${PAGE_HEAD}</head>
<body>
  <img class="logo" src="/assets/logo.svg" alt="Leveret">
  <h1>Set up Leveret</h1>
  <p class="tag">A GitHub App <strong>owned by you</strong>, pointed at <strong>this</strong> server.</p>
  <p>GitHub will show one confirmation screen. The App is created under your account,
  its webhook already points here, and the credentials it returns are written to this
  machine only — Leveret has no hosted side to send them to.</p>
  <form action="${action}" method="post">
    <input type="hidden" name="manifest" value='${manifest.replaceAll("'", "&#39;")}'>
    <label for="owner">Name it after your account or organization</label>
    <input type="text" id="owner" name="owner" value="${(org ?? "").replaceAll('"', "&quot;")}" placeholder="acme" autocomplete="off">
    <small>App names are unique across GitHub, so only one App anywhere can be called
    plain “Leveret”. Keeping the word in front is what preserves the branding: “Leveret
    acme” posts its reviews as <code>leveret-acme[bot]</code>. You can still edit the
    name on GitHub's confirmation screen.</small>
    <button type="submit">Create the App on GitHub</button>
  </form>
  <script>
   const f = document.forms[0];
   f.addEventListener("submit", () => {
     const m = JSON.parse(f.manifest.value);
     m.name = ("Leveret " + f.owner.value.trim()).trim().slice(0, 34);
     f.manifest.value = JSON.stringify(m);
   });
  </script>
</body></html>`;
}

/** After the credentials land: the two things GitHub's manifest flow cannot do for
 * us. The manifest schema has no avatar field, so the hare that appears beside every
 * review comment has to be uploaded by hand — one click, and it is the branding
 * users actually see on a pull request. */
export function renderCallbackPage(htmlUrl: string, org?: string): string {
  const slug = htmlUrl.replace(/\/+$/, "").split("/").pop() ?? "";
  const settings = org
    ? `https://github.com/organizations/${org}/settings/apps/${slug}`
    : `https://github.com/settings/apps/${slug}`;
  return `<!doctype html>
<html><head><title>Leveret is yours</title>${PAGE_HEAD}</head>
<body>
  <img class="logo" src="/assets/logo.svg" alt="Leveret">
  <h1>The App is yours</h1>
  <p class="tag">Credentials stored on this machine, mode 0600. Two steps left.</p>
  <ol>
    <li><strong>Give it its face.</strong> <a href="/assets/logo.png" download>Download the logo</a>,
    then upload it under <em>Display information</em> in
    <a href="${settings}" target="_blank" rel="noreferrer">the App's settings</a>.
    GitHub App manifests carry no avatar field, so this one is manual — and it is the
    logo that shows up beside every review comment.</li>
    <li><strong><a href="${htmlUrl}/installations/new" target="_blank" rel="noreferrer">Install it on your repositories</a></strong>,
    then open a pull request.</li>
  </ol>
</body></html>`;
}

export interface AppCredentials {
  appId: string;
  privateKey: string;
  webhookSecret: string;
}

const CRED_FILE = "app-credentials.json";
const PEM_FILE = "app.pem";

export async function saveCredentials(
  dataDir: string,
  creds: { appId: string; pem: string; webhookSecret: string },
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const pemPath = join(dataDir, PEM_FILE);
  await writeFile(pemPath, creds.pem);
  await chmod(pemPath, 0o600);
  const credPath = join(dataDir, CRED_FILE);
  await writeFile(credPath, `${JSON.stringify({ appId: creds.appId, webhookSecret: creds.webhookSecret }, null, 1)}\n`);
  await chmod(credPath, 0o600);
}

/** Resolution order: env vars win (explicit beats stored), then the data dir,
 * then null — which puts the server in setup mode. */
export async function loadCredentials(
  dataDir: string,
  env: Record<string, string | undefined>,
): Promise<AppCredentials | null> {
  if (env.LEVERET_APP_ID && env.LEVERET_PRIVATE_KEY_PATH && env.LEVERET_WEBHOOK_SECRET) {
    return {
      appId: env.LEVERET_APP_ID,
      privateKey: await readFile(env.LEVERET_PRIVATE_KEY_PATH, "utf8"),
      webhookSecret: env.LEVERET_WEBHOOK_SECRET,
    };
  }
  try {
    const stored = JSON.parse(await readFile(join(dataDir, CRED_FILE), "utf8")) as {
      appId: string;
      webhookSecret: string;
    };
    return {
      appId: stored.appId,
      privateKey: await readFile(join(dataDir, PEM_FILE), "utf8"),
      webhookSecret: stored.webhookSecret,
    };
  } catch {
    return null;
  }
}

/** Exchange the manifest-flow one-time code for the App's credentials. */
export async function convertManifestCode(
  code: string,
): Promise<{ appId: string; pem: string; webhookSecret: string; htmlUrl: string }> {
  const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`manifest conversion failed: ${res.status} ${await res.text()}`);
  const d = (await res.json()) as {
    id: number;
    pem: string;
    webhook_secret: string;
    html_url: string;
  };
  return { appId: String(d.id), pem: d.pem, webhookSecret: d.webhook_secret, htmlUrl: d.html_url };
}
