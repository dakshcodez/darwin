import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Reads the Stripe Projects state from the CLI so every Darwin run can show, in its events feed, the stack that
 * `stripe projects` provisioned (compute, database, LLM). Read-only. Never throws: if the CLI is missing or the
 * project is not initialized, the run continues and the caller gets a short note instead.
 */

export interface StackSummary {
  ok: boolean;
  project?: string;
  services: { name: string; provider: string; service: string; tier: string; status: string }[];
  envVarNames: string[];
  note?: string;
}

// `stripe projects` prints a <claude-code-hint ... /> line before its JSON when run from an agent: strip it.
function parseJson(stdout: string): any {
  return JSON.parse(stdout.split("\n").filter((l) => !l.startsWith("<claude-code-hint")).join("\n"));
}

async function stripeProjects(args: string[]): Promise<any> {
  const { stdout } = await run("stripe", ["projects", ...args, "--json"], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return parseJson(stdout);
}

export async function stackSummary(): Promise<StackSummary> {
  try {
    const status = await stripeProjects(["status"]);
    if (!status.ok) return { ok: false, services: [], envVarNames: [], note: status.error?.message ?? "stripe projects status failed" };
    const raw = status.data?.services ?? [];
    const services = (Array.isArray(raw) ? raw : Object.values(raw)).map((s: any) => ({
      name: s.name,
      provider: s.provider,
      service: s.service_id,
      tier: String(s.pricing ?? ""),
      status: s.status,
    }));
    let envVarNames: string[] = [];
    try {
      const env = await stripeProjects(["env"]);
      // names only: the JSON also carries credential values under access_configuration, which we never read
      const fromResources = (env.data?.resource_access_configurations ?? []).flatMap((r: any) => r.access_configuration_keys ?? []);
      const fromVariables = (env.data?.project_variables ?? []).map((v: any) => v.env_key);
      envVarNames = [...fromResources, ...fromVariables].filter((x: unknown): x is string => typeof x === "string");
    } catch {
      /* env listing is optional */
    }
    return { ok: true, project: status.data?.project?.name, services, envVarNames };
  } catch (e) {
    return { ok: false, services: [], envVarNames: [], note: `stripe CLI unavailable: ${(e as Error).message.split("\n")[0]}` };
  }
}

export function describeStack(s: StackSummary): string {
  if (!s.ok) return `Stripe Projects: ${s.note ?? "not available"}`;
  const svc = s.services.map((x) => `${x.provider}/${x.service} (${x.status})`).join(", ") || "no services";
  const creds = s.envVarNames.length ? `; ${s.envVarNames.length} credentials and settings synced to .env by one CLI` : "";
  return `Stripe Projects stack for "${s.project}": ${svc}${creds}`;
}
