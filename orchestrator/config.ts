import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: path.join(root, ".env") });

/** The standard CreateOS sandbox API. (The organizers asked participants to use https://api-eu.sb.createos.sh; we moved
 *  back to this endpoint on purpose because EU pause/fork/resume stalled often. Set the env vars to switch back.) */
export const DEFAULT_SANDBOX_URL = "https://api.sb.createos.sh";
export const EU_SANDBOX_URL = "https://api-eu.sb.createos.sh";

function pick(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  return undefined;
}

function need(label: string, value: string | undefined, hint: string): string {
  if (!value) throw new Error(`Missing ${label}. ${hint}`);
  return value;
}

export interface Config {
  rootDir: string;
  sandboxBaseUrl: string;
  sandboxApiKey: string;
  databaseUrl: string;
  openrouterApiKey: string | undefined;
  port: number;
}

export function loadConfig(opts: { requireDb?: boolean } = {}): Config {
  const sandboxBaseUrl = (pick("CREATEOS_SANDBOX_BASE_URL", "CREATEOS_SANDBOX_URL") ?? DEFAULT_SANDBOX_URL).replace(/\/+$/, "");
  if (sandboxBaseUrl === EU_SANDBOX_URL) console.warn("[config] using the EU sandbox endpoint (organizer-requested; slower and stall-prone in our tests)");
  // The SDK expects CREATEOS_SANDBOX_API_KEY; Stripe Projects writes CREATEOS_PROJECT_API_KEY / CREATEOS_PLAN_API_KEY.
  const sandboxApiKey = need(
    "CreateOS API key",
    pick("CREATEOS_SANDBOX_API_KEY", "CREATEOS_PROJECT_API_KEY", "CREATEOS_PLAN_API_KEY", "CREATEOS_API_KEY"),
    "Run `stripe projects env --pull`.",
  );
  const databaseUrl =
    opts.requireDb === false
      ? (pick("NEON_POSTGRES_CONNECTION_STRING", "DATABASE_URL") ?? "")
      : need("database URL", pick("NEON_POSTGRES_CONNECTION_STRING", "DATABASE_URL"), "Run `stripe projects env --pull`.");
  return {
    rootDir: root,
    sandboxBaseUrl,
    sandboxApiKey,
    databaseUrl,
    openrouterApiKey: pick("OPENROUTER_API_KEY"),
    port: Number(process.env.PORT ?? 8787),
  };
}
