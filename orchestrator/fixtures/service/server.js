// PLACEHOLDER demo service for orchestrator development. Part B's /service replaces it.
// Deliberate bug: no idempotency on event.id, and a 50 ms gap between "work" and "record".
const http = require("http");
const ledger = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fulfill(event) {
  await sleep(50); // simulated work
  ledger.push({ eventId: event.id, amount: event.data.amount, customer: event.data.customer });
}

http
  .createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && req.url === "/health") return send(200, { ok: true });
    if (req.method === "GET" && req.url === "/ledger") return send(200, { entries: ledger, total: ledger.reduce((a, e) => a + e.amount, 0) });
    if (req.method === "POST" && req.url === "/reset") { ledger.length = 0; return send(200, { ok: true }); }
    if (req.method === "POST" && req.url === "/webhook") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        const event = JSON.parse(raw); // bug: a malformed body throws and crashes the process
        await fulfill(event);
        send(200, { received: true });
      });
      return;
    }
    send(404, { error: "not found" });
  })
  .listen(process.env.PORT || 8080, "0.0.0.0");
