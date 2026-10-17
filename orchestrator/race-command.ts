import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { CreateosSandboxClient } from "@nodeops-createos/sandbox";
import type { AttackReport, Patch, Verdict } from "../contracts/types.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import * as os from "./createos.js";
import { generatePatchesGeneric, judgeGeneric, parseTestCounts, reportFromTestRun } from "./generic-agents.js";
import { describeStack, stackSummary } from "./stripe-projects.js";
import { collectSources, type Target } from "./target.js";

/**
 * "Bring your own code" race. Same idea as race.ts, but the oracle is the project's own test command:
 *   base (project + dependencies) -> baseline test run (the bug reproduces) -> pause -> fork xN
 *   -> per fork: lock egress, apply a model-written patch, run the tests -> judge -> promote the smallest passing patch.
 * No red-team sandbox is needed (every fork runs its own tests), so the peak is base + N forks.
 */

export interface CommandRaceOptions {
  cfg: Config;
  client: CreateosSandboxClient;
  db: Db;
  target: Target;
  /** Write the winning files into the local project (default false: print the diff and save it under .darwin/). */
  apply?: boolean;
  deadlineMs?: number;
}

export interface CommandRaceResult {
  runId: string;
  winnerBranchId: string | null;
  verdicts: Verdict[];
  patchDir: string | null; // where the winner's files and diff were saved
  diff: string | null;
}

const toAbs = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([p, c]) => [path.posix.join(os.APP_DIR, p), c]));
const patchSize = (p: Patch) => Object.values(p.files).reduce((a, c) => a + c.length, 0);

function unifiedDiff(targetDir: string, files: Record<string, string>): string {
  const tmp = mkdtempSync(path.join(tmpdir(), "darwin-diff-"));
  let out = "";
  try {
    for (const [rel, content] of Object.entries(files)) {
      const b = path.join(tmp, "b", rel);
      mkdirSync(path.dirname(b), { recursive: true });
      writeFileSync(b, content);
      try {
        execFileSync("git", ["diff", "--no-index", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", path.join(targetDir, rel), b], { encoding: "utf8" });
      } catch (e) {
        // git diff --no-index exits 1 when the files differ; the diff is on stdout
        out += ((e as { stdout?: string }).stdout ?? "").replaceAll(path.join(targetDir, rel), rel).replaceAll(b, rel);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

export async function runCommandRace(opts: CommandRaceOptions): Promise<CommandRaceResult> {
  const { cfg, client, db, target } = opts;
  if (target.mode !== "command" || !target.test) throw new Error("runCommandRace needs a target in command mode with a test command");
  const sources = collectSources(target);
  let n = target.n;
  const runId = `r${randomBytes(3).toString("hex").slice(0, 5)}`;
  const ev = (kind: Parameters<Db["event"]>[1], m: string) => db.event(runId, kind, m);
  await db.createRun(runId);
  await db.setRunStatus(runId, "running");
  const created: os.Box[] = [];
  let timedOut = false;
  const deadline = opts.deadlineMs ?? 600_000;
  const watchdog = setTimeout(() => {
    timedOut = true;
    void (async () => {
      await ev("error", `run exceeded ${(deadline / 1000).toFixed(0)}s; aborting and destroying sandboxes`);
      await db.setRunStatus(runId, "error").catch(() => undefined);
      await os.destroyAllOurs(client).catch(() => undefined);
    })();
  }, deadline);

  try {
    await ev("provision", describeStack(await stackSummary()));
    await ev("info", `target "${target.name}": ${Object.keys(sources.editable).length} editable file(s), tests: ${target.test}`);
    await ev("info", `bug: ${target.bug}`);

    // Make room: peak is base + n forks, and a fork landing exactly on 5/5 hangs, so keep one slot spare.
    let q = await os.quota(client);
    if (q.running + q.paused > 0) { await ev("cleanup", `${q.running + q.paused} leftover sandbox(es); removing`); await os.destroyAllOurs(client); }
    const drainBy = Date.now() + 60_000;
    q = await os.quota(client);
    while (q.live > 0 && Date.now() < drainBy) { await new Promise((r) => setTimeout(r, 3_000)); q = await os.quota(client); }
    if (q.live > 0) {
      const fit = 4 - q.live - 1;
      if (fit < 2) throw new Error(`only ${5 - q.live} slot(s) free; need at least 4`);
      if (fit < n) await ev("info", `${q.live} slot(s) held by leftovers: using ${fit} forks instead of ${n}`);
      n = Math.min(n, fit);
    }

    // 1. Base sandbox with the project and its dependencies
    const baseId = `${runId}-base`;
    await db.upsertBranch({ id: baseId, runId, status: "forking" });
    let t = Date.now();
    const base = await os.createBox(client, { name: `${runId}-base` });
    created.push(base);
    await os.pushDir(base, target.dir);
    await db.upsertBranch({ id: baseId, runId, sandboxId: base.id, sandboxName: base.name, sandboxIp: base.ip, status: "forking" });
    await ev("provision", `base sandbox ${base.name}: project copied in (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    if (target.install) {
      t = Date.now();
      const inst = await os.sh(base, `cd ${os.APP_DIR} && ${target.install}`, 300_000);
      if (inst.exitCode !== 0) throw new Error(`install failed (${target.install}): ${(inst.stdout + inst.stderr).slice(-300)}`);
      await ev("provision", `dependencies installed with "${target.install}" (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    }

    // 2. Baseline: the tests must fail now, otherwise there is nothing to fix
    t = Date.now();
    const baseline = await os.sh(base, `cd ${os.APP_DIR} && ${target.test}`, target.timeoutSec * 1000);
    const baseOut = baseline.stdout + baseline.stderr;
    const bc = parseTestCounts(baseOut);
    if (baseline.exitCode === 0) throw new Error("the tests already pass on the unmodified project: there is nothing to fix");
    await ev("attack", `baseline: tests FAIL${bc ? ` (${bc.pass}/${bc.total} pass)` : ` (exit ${baseline.exitCode})`}: the bug reproduces (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    await db.saveAttacks({ branchId: baseId, results: [{ name: "test-suite", passed: false, detail: bc ? `${bc.pass}/${bc.total} tests pass (the bug)` : `exit ${baseline.exitCode}` }], finishedAt: new Date().toISOString() });
    await db.setBranchStatus(baseId, "survivor");

    // 3. Candidate patches are written by the model while the base is snapshotted and forked
    const patchesP = generatePatchesGeneric({ target, sources, failingOutput: baseOut, n });
    patchesP.catch(() => undefined);
    t = Date.now();
    await os.pauseBox(base);
    await ev("fork", `base snapshotted (${((Date.now() - t) / 1000).toFixed(1)}s); forking ${n} copies`);
    t = Date.now();
    const forks: os.Box[] = [];
    (await Promise.allSettled(Array.from({ length: n }, () => os.forkBox(base)))).forEach((r) => {
      if (r.status === "fulfilled") { forks.push(r.value); created.push(r.value); }
      else void ev("error", `fork failed: ${(r.reason as Error).message}`);
    });
    const copies = new Set<os.Box>();
    for (let i = forks.length; i < n; i++) {
      try {
        const c = await os.createBox(client, { name: `${runId}-c${i + 1}` });
        created.push(c);
        await os.pushDir(c, target.dir);
        if (target.install) await os.sh(c, `cd ${os.APP_DIR} && ${target.install}`, 300_000);
        forks.push(c);
        copies.add(c);
        await ev("fork", `${c.name} created as a fresh copy (fork unavailable)`);
      } catch (e) { await ev("error", `fallback copy failed: ${(e as Error).message}`); }
    }
    await ev("fork", `${forks.length}/${n} candidates ready: ${forks.length - copies.size} forks, ${copies.size} fresh copies (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    if (!forks.length) throw new Error("no candidate sandboxes could be created");
    void os.destroyBox(base, { wait: false }).catch(() => undefined); // not needed any more; its slot frees up in the background

    // 4. Each fork: lock it down, apply its patch, run the project's tests
    const patches = await patchesP;
    const branches = forks.map((box, i) => ({ box, patch: patches[i] as Patch | undefined, id: `${runId}-${patches[i]?.id ?? `fork-${i + 1}`}` }));
    for (const b of branches) {
      await db.upsertBranch({ id: b.id, runId, parentId: baseId, sandboxId: b.box.id, sandboxName: b.box.name, sandboxIp: b.box.ip, status: "patching", patchRationale: b.patch?.rationale ?? null });
    }
    const reports: AttackReport[] = [];
    await Promise.all(branches.map(async (b) => {
      try {
        if (!b.patch || !Object.keys(b.patch.files).length) throw new Error(b.patch?.rationale ?? "no patch was generated for this fork");
        await os.setEgress(b.box, target.egress.length ? target.egress : ["127.0.0.1"]); // empty list would mean "open"
        await os.pushFiles(b.box, toAbs(b.patch.files));
        await ev("patch", `${b.id}: patch applied to ${Object.keys(b.patch.files).join(", ")} (${b.patch.rationale})`);
        await db.setBranchStatus(b.id, "attacking");
        const r = await os.withDeadline((target.timeoutSec + 20) * 1000, `tests on ${b.id}`, () =>
          os.sh(b.box, `cd ${os.APP_DIR} && ${target.test}`, target.timeoutSec * 1000));
        const report = reportFromTestRun(b.id, r.exitCode, r.stdout + r.stderr);
        await db.saveAttacks(report);
        reports.push(report);
        await ev("attack", `${b.id}: ${report.results[0].detail}`);
      } catch (e) {
        await db.setBranchStatus(b.id, "error");
        await ev("error", `${b.id}: ${(e as Error).message}`);
      }
    }));

    // 5. Judge. Among passing fixes the smallest change wins: natural selection prefers the leaner mutation.
    const verdicts = reports.length ? await judgeGeneric(reports) : [];
    for (const v of verdicts) {
      await db.setBranchVerdict(v.branchId, v.alive ? "survivor" : "killed", v.score, v.reason);
      await ev("verdict", `${v.branchId}: ${v.alive ? "SURVIVES" : "KILLED"} (score ${v.score}). ${v.reason}`);
    }
    const size = (id: string) => { const b = branches.find((x) => x.id === id); return b?.patch ? patchSize(b.patch) : Infinity; };
    const winnerV = verdicts.filter((v) => v.alive).sort((a, b) => b.score - a.score || size(a.branchId) - size(b.branchId))[0];
    const winner = winnerV ? branches.find((b) => b.id === winnerV.branchId)! : null;

    let patchDir: string | null = null;
    let diff: string | null = null;
    if (winner?.patch) {
      await db.setBranchStatus(winner.id, "promoted");
      await ev("verdict", `${winner.id} promoted (${Object.keys(winner.patch.files).join(", ")})`);
      diff = unifiedDiff(target.dir, winner.patch.files);
      patchDir = path.join(target.dir, ".darwin", runId);
      mkdirSync(patchDir, { recursive: true });
      writeFileSync(path.join(patchDir, "winner.patch"), diff);
      for (const [rel, content] of Object.entries(winner.patch.files)) {
        const dest = path.join(patchDir, "files", rel);
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, content);
        if (opts.apply) { mkdirSync(path.dirname(path.join(target.dir, rel)), { recursive: true }); writeFileSync(path.join(target.dir, rel), content); }
      }
      await ev("info", opts.apply ? `winning patch applied to ${target.dir}` : `winning patch saved to ${path.relative(process.cwd(), patchDir) || patchDir}/winner.patch`);
    } else {
      await ev("verdict", "no candidate passed the tests; nothing promoted");
    }

    // 6. Clean up (issued in parallel, not awaited to completion)
    await Promise.allSettled(branches.map((b) => os.destroyBox(b.box, { wait: false })));
    await ev("cleanup", "all sandboxes destroyed");
    if (timedOut) throw new Error("run aborted by the watchdog");
    await db.setRunStatus(runId, "done", winner?.id ?? null);
    return { runId, winnerBranchId: winner?.id ?? null, verdicts, patchDir, diff };
  } catch (e) {
    await ev("error", `run failed: ${(e as Error).message}`);
    await db.setRunStatus(runId, "error");
    await Promise.allSettled(created.map((b) => os.destroyBox(b, { wait: false })));
    throw e;
  } finally {
    clearTimeout(watchdog);
  }
}
