// Demo Stripe-webhook service ("order fulfillment"). Dependency-free so it starts in a locked-down sandbox.
// DELIBERATE BUGS (see README.md): no idempotency by event.id, a 50 ms gap between work and ledger write,
// and a malformed body that crashes the process.
const http = require("http");

const ledger = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fulfill(event) {
  await sleep(50); // simulated fulfillment work
  ledger.push({ eventId: event.id, amount: event.data.amount, customer: event.data.customer });
}

const server = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/health") return send(200, { ok: true });
  if (req.method === "GET" && req.url === "/ledger") {
    return send(200, { entries: ledger, total: ledger.reduce((a, e) => a + e.amount, 0) });
  }
  if (req.method === "POST" && req.url === "/reset") {
    ledger.length = 0;
    return send(200, { ok: true });
  }
  if (req.method === "POST" && req.url === "/webhook") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const event = JSON.parse(raw); // bug: malformed JSON throws inside the handler and crashes the process
      await fulfill(event); // bug: no check on event.id, so duplicates are processed again
      send(200, { received: true });
    });
    return;
  }
  send(404, { error: "not found" });
});

server.listen(process.env.PORT || 8080, "0.0.0.0");
