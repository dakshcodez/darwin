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
import { describeStack, stackSummary } from "./stripe-projects.js";
import { unifiedDiff } from "./race-command.js";

/**
 * One Darwin run:
 *   base (service running) -> pause -> fork xN -> resume the base as the red team
 *   -> per fork: attach, lock egress to the red team, apply patch, restart service, attack
 *   -> judge -> delete the losers, promote the survivor.
 *
 * Quota: the base doubles as the red team, so the peak is base + N forks = 4 with N=3 (no sixth creation, no waiting
 * for a destroyed sandbox to release its slot). We avoid landing exactly on the 5-sandbox cap: that hangs a fork.
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
  /** Hard limit for the whole run (default 8 minutes). On expiry the run is marked failed and our sandboxes are destroyed. */
  deadlineMs?: number;
  /** Called as soon as the run row exists, so a caller (the CLI) can start following it. */
  onRunId?: (runId: string) => void;
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
  let n = opts.n ?? 3;
  // Sandbox names are max 22 chars (lowercase, digits, hyphens): "dw-" + id + "-base" must fit, so keep the id at 6.
  const runId = `r${randomBytes(3).toString("hex").slice(0, 5)}`;
  const serviceDir = resolveServiceDir(cfg, opts.serviceDir);
  const ev = (kind: Parameters<Db["event"]>[1], m: string) => db.event(runId, kind, m);

  await db.createRun(runId);
  opts.onRunId?.(runId);
  await db.setRunStatus(runId, "running");
  await ev("provision", describeStack(await stackSummary())); // shows the Stripe Projects stack in the UI feed
  const created: os.Box[] = [];
  let netId: string | undefined;
  // Watchdog: a stuck SDK call must never leave the UI spinning forever or hold sandbox slots. Destroying our
  // sandboxes makes in-flight calls fail fast, which sends the main flow into its catch block below.
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    void (async () => {
      await ev("error", `run exceeded ${((opts.deadlineMs ?? 480_000) / 1000).toFixed(0)}s; aborting and destroying sandboxes`);
      await db.setRunStatus(runId, "error").catch(() => undefined);
      await os.destroyAllOurs(client).catch(() => undefined);
    })();
  }, opts.deadlineMs ?? 480_000);
  let winner: string | null = null;
  let verdicts: Verdict[] = [];

  try {
    // Make room: leftovers from an earlier run would eat the concurrency cap, and destroyed sandboxes keep
    // counting for a while, so wait until the slots we need are really free (n forks + base at the peak).
    const q0 = await os.quota(client);
    if (q0.running + q0.paused > 0) {
      await ev("cleanup", `${q0.running + q0.paused} sandbox(es) already live; removing leftovers first`);
      await os.destroyAllOurs(client);
    }
    // A fork that lands EXACTLY on 5/5 hangs instead of failing cleanly, so always keep one slot of headroom:
    // peak concurrency is base + n forks, and we need live + n + 1 <= 4. Give leftovers a minute to drain,
    // then shrink n rather than hit the cap.
    let q = await os.quota(client);
    const drainBy = Date.now() + 60_000;
    while (q.live > 0 && Date.now() < drainBy) {
      await new Promise((r) => setTimeout(r, 3_000));
      q = await os.quota(client);
    }
    if (q.live > 0) {
      const fit = 4 - q.live - 1; // forks that fit with one slot spare
      if (fit < 2) throw new Error(`only ${5 - q.live} slot(s) free (${q.live} in use, ${q.other} transitional); need at least 4`);
      if (fit < n) await ev("info", `${q.live} slot(s) still held by leftovers: using ${fit} forks instead of ${n}`);
      n = Math.min(n, fit);
    }
    await ev("info", `slots free: ${5 - q.live} of 5; racing ${n} forks`);

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
    const forks: os.Box[] = [];
    const forkResults = await Promise.allSettled(Array.from({ length: n }, () => os.forkBox(base)));
    forkResults.forEach((r) => {
      if (r.status === "fulfilled") { forks.push(r.value); created.push(r.value); }
      else void ev("error", `fork failed: ${(r.reason as Error).message}`);
    });
    // Fallback for forks that never came up: a fresh sandbox from the same service files (no copied RAM, same race).
    const copies: os.Box[] = [];
    for (let i = forks.length; i < n; i++) {
      try {
        const c = await os.createBox(client, { name: `${runId}-c${i + 1}`, networkId: net.id });
        created.push(c);
        await os.pushFiles(c, toAbs(files));
        await os.startService(c);
        forks.push(c);
        copies.push(c);
        await ev("fork", `${c.name} created as a fresh copy (fork unavailable)`);
      } catch (e) {
        await ev("error", `fallback copy failed: ${(e as Error).message}`);
      }
    }
    await ev("fork", `${forks.length}/${n} candidates ready: ${forks.length - copies.length} forks, ${copies.length} fresh copies (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    if (forks.length === 0) throw new Error("no forks could be created");

    // 3. Red team. Preferred: resume the base (already counted in our slots, already on the private network, so no
    //    new sandbox and no waiting for a destroyed one to release its slot). Resuming is a snapshot restore like a
    //    fork and sometimes stalls, so after 45 s we fall back to promoting one of the running forks to red team
    //    (one candidate fewer, still no extra slot).
    t = Date.now();
    let red: os.Box;
    try {
      await os.withDeadline(45_000, "resume base", () => os.resumeBox(base));
      await base.sandbox.refresh();
      red = { ...base, ip: base.sandbox.ip ?? base.ip };
      await os.attachNetwork(red, net.id).catch(() => undefined); // normally still a member; harmless if already attached
      await ev("provision", `red team = the resumed base sandbox ${red.name} (${red.ip}), no extra slot needed (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    } catch (e) {
      if (forks.length < 2) throw new Error(`base resume failed (${(e as Error).message}) and only ${forks.length} fork(s) are available`);
      red = forks.pop()!;
      await os.attachNetwork(red, net.id).catch(() => undefined);
      await ev("error", `base resume stalled (${(e as Error).message}); using fork ${red.name} (${red.ip}) as the red team instead, racing ${forks.length} candidates`);
      void os.destroyBox(base, { wait: false }).catch(() => undefined);
    }

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
        patchDiff: b.patch && Object.keys(b.patch.files).length ? unifiedDiff(serviceDir, b.patch.files).slice(0, 8000) : null,
      });
    }

    const reports: AttackReport[] = [];
    await Promise.all(
      branches.map(async (b) => {
        try {
          if (!b.patch) throw new Error("no patch generated for this fork");
          if (!copies.includes(b.box)) await os.attachNetwork(b.box, net.id); // fresh copies already joined at creation
          await os.setEgress(b.box, [red.ip]); // internet blocked; only the red team can talk to it
          await os.pushFiles(b.box, toAbs(b.patch.files));
          await os.restartService(b.box);
          await ev("patch", `${b.id}: patch applied, service restarted (${b.patch.rationale})`);
          await db.setBranchStatus(b.id, "attacking");
          // hard 70 s wall clock: a service that stops answering must cost one verdict, never the whole run
          const r = await os.withDeadline(70_000, `attack on ${b.id}`, () =>
            os.exec(red, "node", ["/app/attack.js", `http://${b.box.ip}:${os.SERVICE_PORT}`, b.id], { timeoutMs: 60_000 }),
          );
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

    // 6. Clean up everything except the winner. Destroys are issued in parallel and not awaited to completion
    //    (they take 30-90 s on the EU endpoint); the next run waits for the slots itself.
    const keep = opts.keepWinner === false ? null : winner;
    await Promise.allSettled([
      ...branches.filter((b) => b.id !== keep).map((b) => os.destroyBox(b.box, { wait: false })),
      os.destroyBox(red, { wait: false }),
    ]);
    await ev("cleanup", keep ? `losers and red team destroyed; ${keep} left running` : "all sandboxes destroyed");
    if (!keep) {
      // a network can only be deleted once it has no members, so this is best effort (cleanup.ts retries it later)
      setTimeout(() => void os.deleteNetwork(client, net.id).catch(() => undefined), 90_000).unref();
    }
    netId = undefined;

    await db.setRunStatus(runId, "done", winner);
    return { runId, winnerBranchId: winner, verdicts };
  } catch (e) {
    await ev("error", `run failed: ${(e as Error).message}`);
    await db.setRunStatus(runId, "error");
    // best-effort cleanup so a failed run never blocks the next one
    await Promise.allSettled(created.map((b) => os.destroyBox(b)));
    if (netId) await os.deleteNetwork(client, netId).catch(() => undefined);
    throw e;
  } finally {
    clearTimeout(watchdog);
  }
}
