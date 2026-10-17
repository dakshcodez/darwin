// Starts the service on a random port and shows the duplicate bug. Exits 0 when the bug is reproduced.
const { spawn } = require("child_process");
const path = require("path");
const PORT = 18080 + Math.floor(Math.random() * 1000);
const url = `http://127.0.0.1:${PORT}`;
const child = spawn("node", ["server.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, PORT: String(PORT) }, stdio: "inherit" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = { id: "evt_1", type: "payment_intent.succeeded", data: { amount: 1000, customer: "cus_1" } };
const post = (b) => fetch(url + "/webhook", { method: "POST", body: JSON.stringify(b) }).then((r) => r.status);

(async () => {
  await sleep(500);
  await Promise.all(Array.from({ length: 5 }, () => post(ev)));
  const { entries, total } = await (await fetch(url + "/ledger")).json();
  console.log(`same event delivered 5x -> ${entries.length} ledger entries, total ${total} (want 1 / 1000)`);
  const bug = entries.length > 1;
  console.log(bug ? "BUG REPRODUCED: duplicates were double-processed" : "no bug: event processed once");
  process.exitCode = bug ? 0 : 1;
  child.kill();
})().catch((e) => { console.error(e); child.kill(); process.exit(2); });
