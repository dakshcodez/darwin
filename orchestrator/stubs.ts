import type { AgentApi, AttackReport, Patch, Verdict } from "../contracts/types.js";

/**
 * Stand-in agents so the orchestrator runs end to end before Part B's real /agents land.
 * Same contract as AgentApi. Swap by importing agents/index.ts instead (see race.ts).
 */

const badFix = (src: string) =>
  // lazy fix: checks the seen set, but records the id only AFTER the await -> loses to concurrent duplicates
  src
    .replace("const ledger = [];", "const ledger = [];\nconst seen = new Set();")
    .replace(
      "async function fulfill(event) {\n  await sleep(50); // simulated work\n  ledger.push(",
      "async function fulfill(event) {\n  if (seen.has(event.id)) return;\n  await sleep(50); // simulated work\n  seen.add(event.id);\n  ledger.push(",
    );

const goodFix = (src: string) =>
  // marks the id in-flight BEFORE the await, and rejects malformed bodies with a 400
  badFix(src)
    .replace("  if (seen.has(event.id)) return;\n  await sleep(50); // simulated work\n  seen.add(event.id);", "  if (seen.has(event.id)) return;\n  seen.add(event.id);\n  await sleep(50); // simulated work")
    .replace(
      "        const event = JSON.parse(raw); // bug: a malformed body throws and crashes the process",
      "        let event;\n        try { event = JSON.parse(raw); } catch { return send(400, { error: 'bad json' }); }\n        if (!event || typeof event.id !== 'string' || !event.data) return send(400, { error: 'bad event' });",
    );

const noop = (src: string) => src; // leaves the bug in place

export const stubAgents: AgentApi = {
  async generatePatches({ sourceFiles, n }) {
    const src = sourceFiles["server.js"];
    const all: Patch[] = [
      { id: "patch-a", rationale: "Skip events whose id is already in a seen-set (recorded after the work).", files: { "server.js": badFix(src) } },
      { id: "patch-b", rationale: "Mark the event id in flight before the await and validate the body.", files: { "server.js": goodFix(src) } },
      { id: "patch-c", rationale: "Only add logging; no behavior change.", files: { "server.js": noop(src) } },
      { id: "patch-d", rationale: "Same as patch-a with a different name.", files: { "server.js": badFix(src) } },
    ];
    return all.slice(0, n);
  },

  async getAttackScript() {
    // Minimal real attacks. Usage: node attack.js <TARGET_URL> <BRANCH_ID>; last stdout line = AttackReport JSON.
    return `
const [target, branchId] = process.argv.slice(2);
const post = (body) => fetch(target + "/webhook", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }).then((r) => r.status).catch(() => -1);
const ledger = () => fetch(target + "/ledger").then((r) => r.json());
const ev = (id) => ({ id, type: "payment_intent.succeeded", data: { amount: 1000, customer: "cus_1" } });
const count = async (id) => (await ledger()).entries.filter((e) => e.eventId === id).length;
(async () => {
  const results = [];
  await fetch(target + "/reset", { method: "POST" }).catch(() => {});
  for (let i = 0; i < 5; i++) await post(ev("evt_seq"));
  const seq = await count("evt_seq").catch(() => -1);
  results.push({ name: "sequential-duplicates", passed: seq === 1, detail: "ledger has " + seq + " entries for the same event id (want 1)" });
  await Promise.all(Array.from({ length: 20 }, () => post(ev("evt_conc"))));
  const conc = await count("evt_conc").catch(() => -1);
  results.push({ name: "concurrent-duplicates", passed: conc === 1, detail: "ledger has " + conc + " entries after 20 parallel deliveries (want 1)" });
  const bad = await post("{not json");
  results.push({ name: "malformed-payload", passed: bad >= 400 && bad < 500, detail: "status " + bad + " for malformed body (want 4xx)" });
  const alive = await fetch(target + "/health").then((r) => r.ok).catch(() => false);
  results.push({ name: "still-alive", passed: alive, detail: alive ? "health ok after attacks" : "service is down after attacks" });
  console.log(JSON.stringify({ branchId, results, finishedAt: new Date().toISOString() }));
})();
`;
  },

  async judge(reports: AttackReport[]): Promise<Verdict[]> {
    return reports.map((r) => {
      const failed = r.results.filter((x) => !x.passed);
      const score = Math.round((100 * (r.results.length - failed.length)) / Math.max(1, r.results.length));
      return {
        branchId: r.branchId,
        alive: failed.length === 0,
        score,
        reason: failed.length === 0 ? "Survived every attack." : `Failed: ${failed.map((f) => f.name).join(", ")}.`,
      };
    });
  },
};
