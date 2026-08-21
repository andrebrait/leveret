import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// GitHub App Manifest flow: the CodeRabbit-grade one-click setup where the USER
// owns the App. Our server renders a form that posts a manifest to GitHub; GitHub
// creates the App under the user's account and redirects back with a one-time code
// we exchange for the credentials — which never leave the user's box.

export interface Manifest {
  name: string;
  url: string;
  hook_attributes: { url: string };
  redirect_url: string;
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
}

export function buildManifest(publicUrl: string, name = "Leveret"): Manifest {
  const base = publicUrl.replace(/\/+$/, "");
  return {
    name,
    url: "https://github.com/andrebrait/leveret",
    hook_attributes: { url: `${base}/` },
    redirect_url: `${base}/setup/callback`,
    public: false,
    default_permissions: { pull_requests: "write", contents: "read" },
    default_events: ["pull_request", "pull_request_review_comment"],
  };
}

export function renderSetupPage(publicUrl: string, state: string, org?: string): string {
  const manifest = JSON.stringify(buildManifest(publicUrl));
  const action = org
    ? `https://github.com/organizations/${org}/settings/apps/new?state=${state}`
    : `https://github.com/settings/apps/new?state=${state}`;
  return `<!doctype html>
<html><head><title>Leveret setup</title></head>
<body style="font-family: system-ui; max-width: 40rem; margin: 4rem auto;">
  <h1>Set up Leveret</h1>
  <p>This creates a GitHub App <strong>owned by you</strong>, with its webhook already
  pointing at this server. GitHub will show one confirmation screen; the credentials
  come back here and are stored on this machine only.</p>
  <form action="${action}" method="post">
    <input type="hidden" name="manifest" value='${manifest.replaceAll("'", "&#39;")}'>
    <button type="submit" style="font-size: 1.2rem; padding: .5rem 1.5rem;">Create the App on GitHub</button>
  </form>
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
