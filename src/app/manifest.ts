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
    url: "https://github.com/leveret-dev/leveret",
    hook_attributes: { url: `${hook}/` },
    redirect_url: `${redirect}/setup/callback`,
    public: false,
    default_permissions: { pull_requests: "write", contents: "read" },
    default_events: ["pull_request", "pull_request_review_comment"],
  };
}

// The setup surfaces wear the logo's own palette: the plate, the white mark, and
// the two eyes — a red minus and a green plus — so the pages, the avatar and the
// review comments all read as one product.
const PLATE = "#1d1728";
const MARK = "#fafafa";
const PLUS = "#a7ec21";
const MINUS = "#ff6b68";

/** Every HTML response the App layer emits, in one branded shell. */
export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="icon" href="/assets/logo.svg">
<style>
 :root { color-scheme: dark; }
 body { margin: 0; padding: 3rem 1.25rem; background: ${PLATE}; color: ${MARK};
        font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
 main { max-width: 40rem; margin: 0 auto; }
 header { text-align: center; margin-bottom: 2.5rem; }
 header img { width: 7rem; border-radius: 17%; }
 h1 { font-size: 1.9rem; font-weight: 650; letter-spacing: -.02em; margin: 1rem 0 .35rem; }
 .tag { color: ${MARK}99; margin: 0; }
 a { color: ${PLUS}; }
 code { background: ${MARK}14; padding: .1rem .35rem; border-radius: .25rem;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
 .card { background: ${MARK}0d; border: 1px solid ${MARK}1f; border-radius: .9rem; padding: 1.5rem; }
 label { display: block; font-weight: 600; margin-bottom: .4rem; }
 input[type=text] { width: 100%; box-sizing: border-box; padding: .6rem .75rem; font-size: 1rem;
        color: ${MARK}; background: ${PLATE}; border: 1px solid ${MARK}33; border-radius: .45rem; }
 input[type=text]:focus { outline: 2px solid ${PLUS}; border-color: transparent; }
 small { display: block; color: ${MARK}99; margin-top: .5rem; }
 button { margin-top: 1.5rem; width: 100%; font: inherit; font-weight: 650; padding: .7rem 1.5rem;
        border: 0; border-radius: .45rem; background: ${PLUS}; color: ${PLATE}; cursor: pointer; }
 button:hover { filter: brightness(1.08); }
 .ghost { display: inline-block; margin-top: 1.25rem; padding: .45rem .9rem; border-radius: .45rem;
        border: 1px solid ${MARK}33; color: ${MARK}; text-decoration: none; font-size: .9rem; }
 ol, ul { padding-left: 1.25rem; margin: .5rem 0 0; } li { margin: .4rem 0; }
 h2 { font-size: 1.25rem; font-weight: 600; margin: 0 0 1rem; }
 .note { font-size: .92rem; color: ${MARK}b3; } .note p { margin: 0; }
 .err { color: ${MINUS}; }
</style></head>
<body><main>
  <header>
    <img src="/assets/logo.svg" alt="">
    <h1>Leveret</h1>
    <p class="tag">Self-hosted code review. Nothing about your code leaves this machine.</p>
  </header>
  ${body}
</main></body></html>`;
}

/** Shown at /setup once credentials exist: it asks the reader to delete something,
 * so it names the files outright, full path included (owner ruling 2026-08-22). */
export function renderConfiguredPage(dataDir: string): string {
  return page(
    "Leveret",
    `<h2>GitHub App already configured</h2>
  <div class="card note">
    <p>To reset it, delete these files and reload:</p>
    <ul>
      <li><code>${dataDir}/app-credentials.json</code></li>
      <li><code>${dataDir}/app.pem</code></li>
    </ul>
  </div>`,
  );
}

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
  return page(
    "Set up Leveret",
    `<p>This creates a GitHub App <strong>owned by you</strong>, with its webhook already
  pointing at this server. GitHub shows one confirmation screen; the credentials come
  back here and are stored on this machine only.</p>
  <form class="card" action="${action}" method="post">
    <input type="hidden" name="manifest" value='${manifest.replaceAll("'", "&#39;")}'>
    <label for="owner">Name it after your account or organization</label>
    <input type="text" id="owner" name="owner" value="${(org ?? "").replaceAll('"', "&quot;")}" placeholder="acme" autocomplete="off" spellcheck="false">
    <small>GitHub App names are unique across all of GitHub, so only one App anywhere
    can be called plain &ldquo;Leveret&rdquo;. Leading with the word is what keeps the
    branding: <strong>Leveret acme</strong> signs its reviews
    <code>leveret-acme[bot]</code>. You can still edit the name on GitHub's
    confirmation screen.</small>
    <button type="submit">Create the App on GitHub</button>
  </form>
  <p><a class="ghost" href="/assets/logo.png" download>&#11015; Download the logo (PNG)</a>
  <small>GitHub App manifests carry no avatar field, so the App's picture is the one
  thing set by hand — upload this file under <em>Display information</em> once the App
  exists. It is the logo that appears beside every review comment.</small></p>
  <script>
   const f = document.forms[0];
   f.addEventListener("submit", () => {
     const m = JSON.parse(f.manifest.value);
     m.name = ("Leveret " + f.owner.value.trim()).trim().slice(0, 34);
     f.manifest.value = JSON.stringify(m);
   });
  </script>`,
  );
}

/** After the credentials land: the two things GitHub's manifest flow cannot do for
 * us — the avatar (no manifest field for it) and picking the repositories. */
export function renderCallbackPage(htmlUrl: string, org?: string): string {
  const slug = htmlUrl.replace(/\/+$/, "").split("/").pop() ?? "";
  const settings = org
    ? `https://github.com/organizations/${org}/settings/apps/${slug}`
    : `https://github.com/settings/apps/${slug}`;
  return page(
    "Leveret is yours",
    `<p>The App is yours. Its credentials are on this machine, mode 0600. Two steps left:</p>
  <ol class="card">
    <li><strong>Give it its face.</strong> <a href="/assets/logo.png" download>Download the logo</a>,
    then upload it under <em>Display information</em> in
    <a href="${settings}" target="_blank" rel="noreferrer">the App's settings</a> — this is
    the logo that appears beside every review comment.</li>
    <li><strong><a href="${htmlUrl}/installations/new" target="_blank" rel="noreferrer">Install it on your repositories</a></strong>,
    then open a pull request.</li>
  </ol>`,
  );
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
