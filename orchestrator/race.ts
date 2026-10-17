import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { CreateosSandboxClient } from "@nodeops-createos/sandbox";
import type { AgentApi, AttackReport, Patch, Verdict } from "../contracts/types.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import * as os from "./createos.js";
import { stubAgents } from "./stubs.js";

/**
 * One Darwin run:
 *   base (service running) -> pause -> fork xN -> drop base -> red team joins the network
 *   -> per fork: attach, lock egress to the red team, apply patch, restart service, attack
 *   -> judge -> delete the losers, promote the survivor.
 *
 * Quota: max concurrent sandboxes = N forks + base (until dropped) = 4 with N=3, then N forks + red = 4.
 * We never touch the 5-sandbox cap exactly because a fork that lands on the cap hung in testing.
 */

export interface RaceOptions {
  cfg: Config;
  client: CreateosSandboxClient;
  db: Db;
  agents?: AgentApi;
  /** Directory holding the demo service (package.json + server.js). Defaults to /service, else the orchestrator placeholder. */
  serviceDir?: string;
  n?: number;
  bugReport?: string;
  /** Keep the promoted winner running after the run (default true, handy for the demo). */
  keepWinner?: boolean;
}

export interface RaceResult {
  runId: string;
  winnerBranchId: string | null;
  verdicts: Verdict[];
}

const DEFAULT_BUG =
  "The webhook handler double-processes duplicate Stripe events (same event id) and crashes on malformed bodies. " +
  "Make fulfillment idempotent per event id, including when duplicates arrive concurrently, and reject malformed bodies with 4xx.";

export async function loadAgents(): Promise<AgentApi> {
  if (process.env.DARWIN_AGENTS === "real") {
    // Part B ships agents/index.ts. The path is a variable so typechecking passes before that file exists.
    const modPath = "../agents/index.js";
    return (await import(modPath)) as AgentApi;
  }
  return stubAgents;
}

export async function readServiceFiles(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(rel: string): Promise<void> {
    for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const r = path.join(rel, entry.name);
      if (entry.isDirectory()) await walk(r);
      else out[r] = await readFile(path.join(dir, r), "utf8");
    }
  }
  await walk("");
  return out;
}

function resolveServiceDir(cfg: Config, override?: string): string {
  if (override) return override;
  const real = path.join(cfg.rootDir, "service");
  return existsSync(path.join(real, "package.json")) ? real : path.join(cfg.rootDir, "orchestrator", "fixtures", "service");
}

const toAbs = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([p, c]) => [path.posix.join(os.APP_DIR, p), c]));

function parseReport(stdout: string, branchId: string): AttackReport {
  const last = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  const report = JSON.parse(last) as AttackReport;
  return { ...report, branchId };
}

export async function runRace(opts: RaceOptions): Promise<RaceResult> {
  const { cfg, client, db } = opts;
  const agents = opts.agents ?? (await loadAgents());
  const n = opts.n ?? 3;
  // Sandbox names are max 22 chars (lowercase, digits, hyphens): "dw-" + id + "-base" must fit, so keep the id at 6.
  const runId = `r${randomBytes(3).toString("hex").slice(0, 5)}`;
  const serviceDir = resolveServiceDir(cfg, opts.serviceDir);
  const ev = (kind: Parameters<Db["event"]>[1], m: string) => db.event(runId, kind, m);

  await db.createRun(runId);
  await db.setRunStatus(runId, "running");
  const created: os.Box[] = [];
  let netId: string | undefined;
  let winner: string | null = null;
  let verdicts: Verdict[] = [];

  try {
    // Make room: a leftover sandbox from an earlier run would eat the concurrency cap.
    const q0 = await os.quota(client);
    if (q0.live > 0) {
      await ev("cleanup", `${q0.live} sandbox(es) already live; removing leftovers first`);
      await os.destroyAllOurs(client);
    }
    const q = await os.quota(client);
    if (q.live + n + 1 > 5) throw new Error(`not enough sandbox slots: ${q.live} live, need ${n + 1} (cap 5, other sandboxes are in the way)`);

    const files = await readServiceFiles(serviceDir);
    await ev("info", `service source: ${path.relative(cfg.rootDir, serviceDir)} (${Object.keys(files).length} files), ${n} candidates`);

    // 1. Private network + base sandbox running the buggy service
    const net = await os.createNetwork(client, runId);
    netId = net.id;
    const baseId = `${runId}-base`;
    await db.upsertBranch({ id: baseId, runId, status: "forking" });
    let t = Date.now();
    const base = await os.createBox(client, { name: `${runId}-base`, networkId: net.id });
    created.push(base);
    await os.pushFiles(base, toAbs(files));
    await os.startService(base);
    await db.upsertBranch({ id: baseId, runId, sandboxId: base.id, sandboxName: base.name, sandboxIp: base.ip, status: "survivor" });
    await ev("provision", `base sandbox ${base.name} running the buggy service (${((Date.now() - t) / 1000).toFixed(1)}s)`);

    // 2. Pause the base (snapshots RAM and processes), then fork N copies in parallel
    t = Date.now();
    await os.pauseBox(base);
    await ev("fork", `base paused (${((Date.now() - t) / 1000).toFixed(1)}s); forking ${n} copies`);

    // Candidate patches are generated while the forks boot.
    const patchesP = agents.generatePatches({ sourceFiles: files, bugReport: opts.bugReport ?? DEFAULT_BUG, n });
    patchesP.catch(() => undefined); // surfaced when awaited below; avoids an unhandled rejection if forking fails first
    t = Date.now();
    const forkResults = await Promise.allSettled(Array.from({ length: n }, () => os.forkBox(base)));
    const forks: os.Box[] = [];
    forkResults.forEach((r, i) => {
      if (r.status === "fulfilled") { forks.push(r.value); created.push(r.value); }
      else void ev("error", `fork ${i + 1} failed: ${(r.reason as Error).message}`);
    });
    await ev("fork", `${forks.length}/${n} forks running (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    if (forks.length === 0) throw new Error("no forks could be created");

    // 3. Drop the base (frees a slot), then bring in the red team on the same network
    await os.destroyBox(base).catch(() => undefined);
    await ev("cleanup", "base sandbox destroyed (slot freed)");
    const red = await os.createBox(client, { name: `${runId}-red`, networkId: net.id });
    created.push(red);
    await ev("provision", `red-team sandbox ${red.name} (${red.ip}) joined the network`);

    const patches = await patchesP;
    const attackScript = await agents.getAttackScript({ sourceFiles: files });
    await os.pushFiles(red, { "/app/attack.js": attackScript });

    // 4. Each fork: attach, lock egress to the red team only, apply its patch, restart, attack
    const branches = forks.map((box, i) => {
      const patch: Patch | undefined = patches[i];
      return { box, patch, id: `${runId}-${patch?.id ?? `fork-${i + 1}`}` };
    });
    for (const b of branches) {
      await db.upsertBranch({
        id: b.id, runId, parentId: baseId, sandboxId: b.box.id, sandboxName: b.box.name, sandboxIp: b.box.ip,
        status: "patching", patchRationale: b.patch?.rationale ?? null,
      });
    }

    const reports: AttackReport[] = [];
    await Promise.all(
      branches.map(async (b) => {
        try {
          if (!b.patch) throw new Error("no patch generated for this fork");
          await os.attachNetwork(b.box, net.id);
          await os.setEgress(b.box, [red.ip]); // internet blocked; only the red team can talk to it
          await os.pushFiles(b.box, toAbs(b.patch.files));
          await os.restartService(b.box);
          await ev("patch", `${b.id}: patch applied, service restarted (${b.patch.rationale})`);
          await db.setBranchStatus(b.id, "attacking");
          const r = await os.exec(red, "node", ["/app/attack.js", `http://${b.box.ip}:${os.SERVICE_PORT}`, b.id], { timeoutMs: 150_000 });
          const report = parseReport(r.stdout, b.id);
          await db.saveAttacks(report);
          reports.push(report);
          const failed = report.results.filter((x) => !x.passed).length;
          await ev("attack", `${b.id}: ${report.results.length - failed}/${report.results.length} attacks survived`);
        } catch (e) {
          await db.setBranchStatus(b.id, "error");
          await ev("error", `${b.id}: ${(e as Error).message}`);
        }
      }),
    );

    // 5. Judge, kill the losers, promote the survivor
    verdicts = reports.length ? await agents.judge(reports) : [];
    for (const v of verdicts) {
      await db.setBranchVerdict(v.branchId, v.alive ? "survivor" : "killed", v.score, v.reason);
      await ev("verdict", `${v.branchId}: ${v.alive ? "SURVIVES" : "KILLED"} (score ${v.score}). ${v.reason}`);
    }
    const alive = verdicts.filter((v) => v.alive).sort((a, b) => b.score - a.score);
    winner = alive[0]?.branchId ?? null;
    if (winner) {
      await db.setBranchStatus(winner, "promoted");
      await ev("verdict", `${winner} promoted`);
    } else {
      await ev("verdict", "no branch survived; nothing promoted");
    }

    // 6. Clean up everything except the winner
    const keep = opts.keepWinner === false ? null : winner;
    for (const b of branches) {
      if (b.id === keep) continue;
      await os.destroyBox(b.box).catch(() => undefined);
    }
    await os.destroyBox(red).catch(() => undefined);
    await ev("cleanup", keep ? `losers and red team destroyed; ${keep} left running` : "all sandboxes destroyed");
    if (!keep) await os.deleteNetwork(client, net.id).catch(() => undefined);
    netId = keep ? undefined : netId; // the network stays while the winner is a member

    await db.setRunStatus(runId, "done", winner);
    return { runId, winnerBranchId: winner, verdicts };
  } catch (e) {
    await ev("error", `run failed: ${(e as Error).message}`);
    await db.setRunStatus(runId, "error");
    // best-effort cleanup so a failed run never blocks the next one
    await Promise.allSettled(created.map((b) => os.destroyBox(b)));
    if (netId) await os.deleteNetwork(client, netId).catch(() => undefined);
    throw e;
  }
}
