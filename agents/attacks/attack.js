// Red-team suite. Usage: node attack.js <TARGET_URL> <BRANCH_ID>
// Dependency-free (Node 20 global fetch). Prints ONE AttackReport as JSON on the LAST stdout line.
const [target, branchId = "unknown"] = process.argv.slice(2);
if (!target) { console.error("usage: node attack.js <TARGET_URL> <BRANCH_ID>"); process.exit(2); }

const T = 8000;
const raw = (body) =>
  fetch(target + "/webhook", { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(T) })
    .then((r) => r.status)
    .catch(() => -1); // -1 = connection refused / timeout (service down)
const post = (obj) => raw(typeof obj === "string" ? obj : JSON.stringify(obj));
const ev = (id, amount = 1000) => ({ id, type: "payment_intent.succeeded", data: { amount, customer: "cus_1" } });
const ledger = () => fetch(target + "/ledger", { signal: AbortSignal.timeout(T) }).then((r) => r.json());
const count = async (id) => (await ledger()).entries.filter((e) => e.eventId === id).length;
const healthy = () => fetch(target + "/health", { signal: AbortSignal.timeout(T) }).then((r) => r.ok).catch(() => false);

const results = [];
const check = async (name, fn) => {
  try {
    const [passed, detail] = await fn();
    results.push({ name, passed, detail });
  } catch (e) {
    results.push({ name, passed: false, detail: "attack errored: " + (e && e.message ? e.message : e) });
  }
};

(async () => {
  await fetch(target + "/reset", { method: "POST", signal: AbortSignal.timeout(T) }).catch(() => {});

  await check("sequential-duplicates", async () => {
    for (let i = 0; i < 5; i++) await post(ev("evt_seq"));
    const n = await count("evt_seq");
    return [n === 1, `same event id delivered 5x in sequence -> ${n} ledger entries (want 1)`];
  });

  await check("concurrent-duplicates", async () => {
    await Promise.all(Array.from({ length: 20 }, () => post(ev("evt_conc"))));
    const n = await count("evt_conc");
    return [n === 1, `same event id delivered 20x in parallel -> ${n} ledger entries (want 1)`];
  });

  await check("malformed-payloads", async () => {
    const bodies = [
      ["not json", "{not json"],
      ["empty body", ""],
      ["missing id", JSON.stringify({ type: "payment_intent.succeeded", data: { amount: 1, customer: "c" } })],
      ["numeric id", JSON.stringify({ id: 123, type: "payment_intent.succeeded", data: { amount: 1, customer: "c" } })],
      ["missing data", JSON.stringify({ id: "evt_bad1", type: "payment_intent.succeeded" })],
      ["string amount", JSON.stringify({ id: "evt_bad2", type: "payment_intent.succeeded", data: { amount: "lots", customer: "c" } })],
      ["json null", "null"],
    ];
    const bad = [];
    for (const [label, body] of bodies) {
      const s = await raw(body);
      if (!(s >= 400 && s < 500)) bad.push(`${label}=${s}`);
    }
    return [bad.length === 0, bad.length ? `expected 4xx, got: ${bad.join(", ")}` : `all ${bodies.length} malformed payloads rejected with 4xx`];
  });

  await check("valid-after-malformed", async () => {
    const s = await post(ev("evt_after"));
    const n = await count("evt_after").catch(() => -1);
    return [s === 200 && n === 1, `valid event after malformed ones -> status ${s}, ${n} ledger entries (want 200 / 1)`];
  });

  await check("replay-old-event", async () => {
    await post(ev("evt_other_1"));
    await post(ev("evt_other_2"));
    await post(ev("evt_seq")); // replay of the first event, long after it was processed
    const n = await count("evt_seq");
    return [n === 1, `old event replayed after others -> ${n} ledger entries for it (want 1)`];
  });

  await check("health-alive", async () => {
    const ok = await healthy();
    return [ok, ok ? "GET /health ok after all attacks" : "service is down after the attacks"];
  });

  console.log(JSON.stringify({ branchId, results, finishedAt: new Date().toISOString() }));
})();
