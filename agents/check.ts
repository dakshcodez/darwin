// Offline harness: npx tsx agents/check.ts   (DARWIN_N=3 for the patch count). No sandboxes involved.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttackReport } from "../contracts/types.js";
import { generatePatches, getAttackScript, judge } from "./index.js";

const n = Number(process.env.DARWIN_N ?? 3);
const svc = join(dirname(fileURLToPath(import.meta.url)), "..", "service");
const sourceFiles: Record<string, string> = { "server.js": readFileSync(join(svc, "server.js"), "utf8") };
const bugReport =
  "Stripe retries webhook deliveries. Duplicate events (same event.id) are double-processed into the ledger, including concurrent duplicates, and malformed bodies crash the service. Fix it.";

const patches = await generatePatches({ sourceFiles, bugReport, n });
const script = await getAttackScript({ sourceFiles });
const dir = mkdtempSync(join(tmpdir(), "darwin-check-"));
writeFileSync(join(dir, "attack.js"), script);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reports: AttackReport[] = [];

for (const [i, p] of patches.entries()) {
  const d = join(dir, p.id);
  mkdirSync(d);
  for (const f of readdirSync(svc)) if (f !== "test" && f !== "node_modules") cpSync(join(svc, f), join(d, f), { recursive: true });
  for (const [path, content] of Object.entries(p.files)) writeFileSync(join(d, path), content);
  const port = 19100 + i;
  const child = spawn("node", ["server.js"], { cwd: d, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  await sleep(700);
  const out = await new Promise<string>((res) => {
    let s = "";
    const a = spawn("node", [join(dir, "attack.js"), `http://127.0.0.1:${port}`, p.id]);
    a.stdout.on("data", (c) => (s += c));
    a.on("close", () => res(s));
  });
  child.kill();
  reports.push(JSON.parse(out.trim().split("\n").pop()!));
  console.log(`\n${p.id}: ${p.rationale}`);
}

const verdicts = await judge(reports);
for (const v of verdicts) console.log(`${v.alive ? "SURVIVOR" : "killed  "} ${v.branchId} score=${v.score}  ${v.reason}`);
console.log(`\n${verdicts.filter((v) => v.alive).length}/${verdicts.length} survived`);
process.exit(0);
