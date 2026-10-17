// Local bench for "bring your own code" targets. No sandboxes: it runs the model's patches against the project's own
// tests in temp copies on this machine. Usage: npm run check:target -- examples/slugify   (or --example slugify)
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { collectSources, loadTarget } from "../orchestrator/target.js";
import { generatePatchesGeneric, judgeGeneric, parseTestCounts, reportFromTestRun } from "../orchestrator/generic-agents.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { example: { type: "string" }, bug: { type: "string" }, test: { type: "string" }, n: { type: "string" } } });
const target = loadTarget({ path: positionals[0], example: values.example, bug: values.bug, test: values.test, n: values.n ? Number(values.n) : undefined });
const sources = collectSources(target);
console.log(`target ${target.name}: ${Object.keys(sources.editable).length} editable file(s), ${Object.keys(sources.context).length} read-only, test: ${target.test}`);

const run = (cwd: string) => {
  const r = spawnSync("sh", ["-c", target.test!], { cwd, encoding: "utf8", timeout: target.timeoutSec * 1000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
};
const base = run(target.dir);
const baseCounts = parseTestCounts(base.out);
console.log(`baseline: exit ${base.code}${baseCounts ? `, ${baseCounts.pass}/${baseCounts.total} pass` : ""}`);
if (base.code === 0) { console.log("the tests already pass: nothing to fix"); process.exit(0); }

const t0 = Date.now();
const patches = await generatePatchesGeneric({ target, sources, failingOutput: base.out, n: target.n });
console.log(`generated ${patches.length} patch(es) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const tmp = mkdtempSync(path.join(tmpdir(), "darwin-target-"));
const reports = [];
for (const p of patches) {
  if (!Object.keys(p.files).length) { console.log(`${p.id}: ${p.rationale}`); continue; }
  const dir = path.join(tmp, p.id);
  cpSync(target.dir, dir, { recursive: true, filter: (s) => !s.includes("node_modules") });
  for (const [rel, content] of Object.entries(p.files)) { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), content); }
  const r = run(dir);
  const report = reportFromTestRun(p.id, r.code, r.out);
  reports.push(report);
  console.log(`${p.id}: ${report.results[0].detail}   | ${p.rationale.slice(0, 90)}`);
}
for (const v of await judgeGeneric(reports)) console.log(`  ${v.branchId} ${v.alive ? "SURVIVES" : "KILLED  "} score ${String(v.score).padStart(3)}  ${v.reason}`);
rmSync(tmp, { recursive: true, force: true });
process.exit(0);
