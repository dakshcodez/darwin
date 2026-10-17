import { createClient, type Sandbox, type CreateosSandboxClient } from "@nodeops-createos/sandbox";
import type { Config } from "./config.js";

/**
 * Thin wrapper over the CreateOS Sandbox SDK. Everything here is timeout-bounded because pause/fork are
 * asynchronous and we saw a fork hang when the account sat exactly on its concurrency cap.
 *
 * Facts verified pre-kickoff (see CLAUDE.md 3.2a):
 *  - private-network DNS by name does not resolve: always address peers by IP
 *  - a fork does NOT inherit the base's network membership: attach it explicitly
 *  - an egress allowlist also cuts private-network traffic: include the red team's IP in each fork's allowlist
 */

export interface Box {
  sandbox: Sandbox;
  id: string;
  name: string;
  ip: string;
}

export const NAME_PREFIX = "dw-";
export const APP_DIR = "/app";
export const SERVICE_PORT = 8080;

const T = {
  create: 90_000,
  pause: 120_000,
  fork: 180_000,
  destroy: 90_000,
  exec: 120_000,
  port: 30_000,
};

export function makeClient(cfg: Config): CreateosSandboxClient {
  return createClient({ apiKey: cfg.sandboxApiKey, baseUrl: cfg.sandboxBaseUrl });
}

async function toBox(sandbox: Sandbox): Promise<Box> {
  await sandbox.refresh();
  if (!sandbox.ip) throw new Error(`sandbox ${sandbox.id} has no IP (status ${sandbox.status})`);
  return { sandbox, id: sandbox.id, name: sandbox.name ?? sandbox.id, ip: sandbox.ip };
}

export interface CreateBoxOptions {
  name: string;
  shape?: string;
  rootfs?: string;
  networkId?: string;
  egress?: string[];
  ingress?: boolean;
  envs?: Record<string, string>;
}

export async function createBox(client: CreateosSandboxClient, o: CreateBoxOptions): Promise<Box> {
  const sandbox = await client.createSandbox(
    {
      shape: o.shape ?? "s-1vcpu-1gb",
      rootfs: o.rootfs ?? "devbox:1",
      name: `${NAME_PREFIX}${o.name}`,
      networks: o.networkId ? [{ id: o.networkId }] : undefined,
      egress: o.egress,
      ingress_enabled: o.ingress,
      envs: o.envs,
    },
    { wait: true, waitTimeoutMs: T.create },
  );
  return toBox(sandbox);
}

/** Upload a map of absolute-path -> text content. */
export async function pushFiles(box: Box, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith("/")) throw new Error(`pushFiles needs absolute paths, got ${path}`);
    await box.sandbox.files.upload(path, content, { timeoutMs: T.exec });
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  ms: number;
}

/** Run one command to completion. Never run a background job here (it blocks): use startProcess. */
export async function exec(box: Box, cmd: string, args: string[] = [], opts: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<ExecResult> {
  const { result, exec_ms } = await box.sandbox.runCommand(cmd, args, { env: opts.env, timeoutMs: opts.timeoutMs ?? T.exec });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exit_code, ms: exec_ms };
}

export async function sh(box: Box, script: string, timeoutMs = T.exec): Promise<ExecResult> {
  return exec(box, "sh", ["-c", script], { timeoutMs });
}

/** Start the demo service as a managed (reconnectable) process and wait until the port answers. */
export async function startService(box: Box, opts: { cwd?: string; cmd?: string; args?: string[]; env?: Record<string, string> } = {}): Promise<string> {
  const proc = await box.sandbox.processes.create({
    cmd: opts.cmd ?? "npm",
    args: opts.args ?? ["start"],
    cwd: opts.cwd ?? APP_DIR,
    env: { PORT: String(SERVICE_PORT), ...(opts.env ?? {}) },
  });
  await box.sandbox.waitForPortReady(SERVICE_PORT, { timeoutMs: T.port });
  return proc.process_id;
}

export async function stopProcess(box: Box, processId: string): Promise<void> {
  await box.sandbox.processes.delete(processId).catch(() => undefined);
}

export async function pauseBox(box: Box): Promise<void> {
  await box.sandbox.pause({ timeoutMs: T.pause });
  await box.sandbox.waitUntilPaused({ timeoutMs: T.pause });
}

/** Fork a PAUSED base. Returns once the fork is running (or paused if startPaused). */
export async function forkBox(base: Box, opts: { startPaused?: boolean; egress?: string[] } = {}): Promise<Box> {
  const fork = await base.sandbox.fork({ start_paused: opts.startPaused, egress: opts.egress }, { timeoutMs: T.fork });
  if (opts.startPaused) await fork.waitUntilPaused({ timeoutMs: T.fork });
  else await fork.waitUntilRunning({ timeoutMs: T.fork });
  return toBox(fork);
}

export async function resumeBox(box: Box): Promise<void> {
  await box.sandbox.resume({ timeoutMs: T.pause });
  await box.sandbox.waitUntilRunning({ timeoutMs: T.pause });
}

export async function destroyBox(box: Pick<Box, "sandbox">): Promise<void> {
  await box.sandbox.destroy({ timeoutMs: T.destroy });
  await box.sandbox.waitUntilDestroyed({ timeoutMs: T.destroy }).catch(() => undefined);
}

/** Lock a sandbox's outbound traffic. Always pass the red team's IP so private-network attacks still reach it. */
export async function setEgress(box: Box, allow: string[]): Promise<void> {
  await box.sandbox.setEgress(allow, { timeoutMs: T.exec });
}

// ---------------------------------------------------------------------------
// Networks
// ---------------------------------------------------------------------------

export async function createNetwork(client: CreateosSandboxClient, name: string): Promise<{ id: string; name: string }> {
  const net = await client.networks.create({ name: `${NAME_PREFIX}${name}` });
  return { id: net.id, name: net.name };
}

/** Forks start outside the base's network. Attach explicitly after the fork is running. */
export async function attachNetwork(box: Box, networkId: string): Promise<void> {
  await box.sandbox.attachNetwork(networkId, { timeoutMs: T.exec });
}

export async function deleteNetwork(client: CreateosSandboxClient, networkId: string): Promise<void> {
  await client.networks.delete(networkId);
}

// ---------------------------------------------------------------------------
// Quota and cleanup
// ---------------------------------------------------------------------------

export interface Quota {
  running: number;
  paused: number;
  other: number;
  total: number;
  /** concurrent sandboxes counting against the cap (paused ones count) */
  live: number;
}

export async function quota(client: CreateosSandboxClient): Promise<Quota> {
  const w = await client.whoami();
  const s = w.stats;
  return { running: s.running, paused: s.paused, other: s.other, total: s.total, live: s.running + s.paused };
}

/** Destroy every non-destroyed sandbox whose name starts with our prefix, plus any named network. */
export async function destroyAllOurs(client: CreateosSandboxClient): Promise<{ destroyed: string[]; networks: string[] }> {
  const destroyed: string[] = [];
  const all = await client.listSandboxes();
  for (const sb of all) {
    if (sb.status === "destroyed" || sb.status === "destroying") continue;
    const ours = (sb.name ?? "").startsWith(NAME_PREFIX) || forkedFromOurs(sb, all);
    if (!ours) continue;
    await sb.destroy({ timeoutMs: T.destroy }).catch(() => undefined);
    destroyed.push(sb.name ?? sb.id);
  }
  const networks: string[] = [];
  for (const net of await client.networks.list()) {
    if (!net.name.startsWith(NAME_PREFIX)) continue;
    await client.networks.delete(net.id).catch(() => undefined);
    networks.push(net.name);
  }
  return { destroyed, networks };
}

// Forks get auto-generated names, so treat a sandbox forked from one of ours as ours.
function forkedFromOurs(sb: Sandbox, all: Sandbox[]): boolean {
  const parent = sb.data.forked_from;
  if (!parent) return false;
  const p = all.find((x) => x.id === parent);
  return !!p && ((p.name ?? "").startsWith(NAME_PREFIX) || forkedFromOurs(p, all));
}
