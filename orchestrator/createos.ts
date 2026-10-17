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
  forkDeadline: 75_000,
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
      // env keys used later by exec/process must be declared here: undeclared keys are rejected with a 400
      envs: { PORT: String(SERVICE_PORT), ...(o.envs ?? {}) },
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
  // retry: false because the SDK's default retry re-sends a timed-out exec, which would run the same attack again
  const { result, exec_ms } = await box.sandbox.runCommand(cmd, args, { env: opts.env, timeoutMs: opts.timeoutMs ?? T.exec, retry: false });
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
    env: { PORT: String(SERVICE_PORT), ...(opts.env ?? {}) }, // every key must have been declared at createBox time
  });
  await box.sandbox.waitForPortReady(SERVICE_PORT, { timeoutMs: T.port });
  return proc.process_id;
}

/** Stop every managed process in the box (a fork inherits the base's running service), then start the service again. */
export async function restartService(box: Box, opts: Parameters<typeof startService>[1] = {}): Promise<string> {
  const { processes } = await box.sandbox.processes.list();
  for (const p of processes) {
    if (p.state === "running") await box.sandbox.processes.delete(p.process_id, { graceMs: 500 }).catch(() => undefined);
  }
  await sh(box, "pkill -f 'node server.js' || true", 20_000); // belt and braces: free port 8080 before restarting
  return startService(box, opts);
}

export async function stopProcess(box: Box, processId: string): Promise<void> {
  await box.sandbox.processes.delete(processId).catch(() => undefined);
}

export async function pauseBox(box: Box): Promise<void> {
  await box.sandbox.pause({ timeoutMs: T.pause });
  await box.sandbox.waitUntilPaused({ timeoutMs: T.pause });
}

/** Reject after `ms` no matter what the SDK is doing, and abort its in-flight requests. */
export async function withDeadline<T>(ms: number, label: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`${label} exceeded ${(ms / 1000).toFixed(0)}s`)), ms);
  try {
    return await Promise.race([
      fn(ac.signal),
      new Promise<never>((_, reject) => ac.signal.addEventListener("abort", () => reject(ac.signal.reason as Error))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fork a PAUSED base. Returns once the fork is running (or paused if startPaused).
 * Forks sometimes hang on the EU endpoint (one 10-minute hang, several 60-180 s stalls), so every fork has a hard
 * wall-clock deadline and a stuck fork is destroyed instead of leaking a slot. Callers fall back to a fresh copy.
 */
export async function forkBox(base: Box, opts: { startPaused?: boolean; egress?: string[]; deadlineMs?: number } = {}): Promise<Box> {
  const deadlineMs = opts.deadlineMs ?? T.forkDeadline;
  let fork: Sandbox | undefined;
  try {
    await withDeadline(deadlineMs, "fork", async (signal) => {
      fork = await base.sandbox.fork({ start_paused: opts.startPaused, egress: opts.egress }, { timeoutMs: T.exec, signal });
      if (opts.startPaused) await fork.waitUntilPaused({ timeoutMs: deadlineMs, signal });
      else await fork.waitUntilRunning({ timeoutMs: deadlineMs, signal });
    });
    return await toBox(fork!);
  } catch (e) {
    if (fork) await fork.destroy({ timeoutMs: T.destroy }).catch(() => undefined);
    throw e;
  }
}

export async function resumeBox(box: Box): Promise<void> {
  await box.sandbox.resume({ timeoutMs: T.pause });
  await box.sandbox.waitUntilRunning({ timeoutMs: T.pause });
}

/** Destroy a sandbox. `wait: false` returns as soon as the destroy is accepted (EU destroys take 30-90 s to finish). */
export async function destroyBox(box: Pick<Box, "sandbox">, opts: { wait?: boolean } = {}): Promise<void> {
  await box.sandbox.destroy({ timeoutMs: T.destroy });
  if (opts.wait !== false) await box.sandbox.waitUntilDestroyed({ timeoutMs: T.destroy }).catch(() => undefined);
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
  /** concurrent sandboxes counting against the cap: running + paused + transitional (destroying, forking, failed) */
  live: number;
}

export async function quota(client: CreateosSandboxClient): Promise<Quota> {
  const w = await client.whoami();
  const s = w.stats;
  return { running: s.running, paused: s.paused, other: s.other, total: s.total, live: s.running + s.paused + s.other };
}

/**
 * Wait until at least `needed` slots are free under the cap (default 5). Destroyed sandboxes keep counting in the
 * "other" bucket for a while, so back-to-back runs must wait or they hit `429 concurrent quota reached`.
 */
export async function waitForSlots(client: CreateosSandboxClient, needed: number, opts: { cap?: number; timeoutMs?: number } = {}): Promise<Quota> {
  const cap = opts.cap ?? 5;
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  for (;;) {
    const q = await quota(client);
    if (q.live + needed <= cap) return q;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${needed} free slot(s); ${q.live}/${cap} in use (running ${q.running}, paused ${q.paused}, transitional ${q.other})`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
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
