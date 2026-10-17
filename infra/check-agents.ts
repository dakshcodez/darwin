// Part B's local test bench: runs the real agents/index.ts against the demo service on localhost.
// No sandboxes, no CreateOS quota. Mirrors what the orchestrator does in a race:
//   generatePatches -> for each patch: start the patched service -> run the attack script -> judge.
// Usage: npm run check:agents            (uses /service if it exists, else the orchestrator placeholder)
//        DARWIN_N=3 npm run check:agents
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentApi, AttackReport } from "../contracts/types.js";
import { readServiceFiles } from "../orchestrator/race.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const n = Number(process.env.DARWIN_N ?? 3);
const serviceDir = existsSync(path.join(root, "service", "package.json")) ? path.join(root, "service") : path.join(root, "orchestrator", "fixtures", "service");
console.log(`service: ${path.relative(root, serviceDir)}   patches: ${n}`);

const agentsPath = path.join(root, "agents", "index.ts");
if (!existsSync(agentsPath)) {
  console.error("agents/index.ts does not exist yet (Part B). Expected exports: generatePatches, getAttackScript, judge (see contracts/types.ts AgentApi).");
  process.exit(2);
}
const agents = (await import(agentsPath)) as AgentApi;
for (const fn of ["generatePatches", "getAttackScript", "judge"] as const) {
  if (typeof agents[fn] !== "function") { console.error(`agents/index.ts is missing export: ${fn}`); process.exit(2); }
}

const sourceFiles = await readServiceFiles(serviceDir);
const bugReport = "The webhook handler double-processes duplicate Stripe events and crashes on malformed bodies. Make it idempotent per event id, including concurrent duplicates, and reject malformed bodies with 4xx.";

let t = Date.now();
const patches = await agents.generatePatches({ sourceFiles, bugReport, n });
console.log(`generatePatches: ${patches.length} patches in ${((Date.now() - t) / 1000).toFixed(1)}s`);
if (patches.length !== n) console.warn(`  warning: asked for ${n}, got ${patches.length}`);

const script = await agents.getAttackScript({ sourceFiles });
const tmp = await mkdtemp(path.join(tmpdir(), "darwin-check-"));
const attackFile = path.join(tmp, "attack.js");
await writeFile(attackFile, script);

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), 60_000);
    p.on("close", (code) => { clearTimeout(timer); resolve({ stdout: out, code }); });
  });
}

const reports: AttackReport[] = [];
let port = 18100;
for (const patch of patches) {
  const dir = path.join(tmp, patch.id);
  await mkdir(dir, { recursive: true });
  await cp(serviceDir, dir, { recursive: true, filter: (s) => !s.includes("node_modules") });
  for (const [rel, content] of Object.entries(patch.files)) {
    const dest = path.join(dir, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content);
  }
  const p = port++;
  const server: ChildProcess = spawn("npm", ["start", "--silent"], { cwd: dir, env: { ...process.env, PORT: String(p) }, stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    up = await fetch(`http://127.0.0.1:${p}/health`).then((r) => r.ok).catch(() => false);
  }
  if (!up) { console.log(`${patch.id}: service did not start (check the patch)`); server.kill(); continue; }
  t = Date.now();
  const r = await run("node", [attackFile, `http://127.0.0.1:${p}`, patch.id]);
  server.kill();
  try {
    const last = r.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    const report = JSON.parse(last) as AttackReport;
    if (!Array.isArray(report.results)) throw new Error("report.results is not an array");
    reports.push({ ...report, branchId: patch.id });
    console.log(`${patch.id.padEnd(10)} ${report.results.map((x) => (x.passed ? "PASS" : "FAIL") + ":" + x.name).join(" ")}  (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  } catch (e) {
    console.log(`${patch.id}: attack script did not print an AttackReport as the LAST stdout line (${(e as Error).message}). Output tail:\n${r.stdout.slice(-400)}`);
  }
}

const verdicts = await agents.judge(reports);
console.log("\nverdicts:");
for (const v of verdicts) console.log(`  ${v.branchId.padEnd(10)} ${v.alive ? "SURVIVES" : "KILLED  "} score ${String(v.score).padStart(3)}  ${v.reason}`);
const alive = verdicts.filter((v) => v.alive).length;
console.log(`\n${alive} of ${verdicts.length} survive. Demo target: exactly 1 survivor (all-pass or all-fail makes a dull demo).`);
await rm(tmp, { recursive: true, force: true });
process.exit(0);
