import express from "express";
import Stripe from "stripe";
import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { makeClient, quota } from "./createos.js";
import { runRace } from "./race.js";

/**
 * API for the UI (polled every second):
 *   GET  /api/runs/latest   -> RunState (latest run, its branches, attacks, events)
 *   GET  /api/runs/:id      -> RunState for one run
 *   POST /api/runs          -> start a run, returns { runId } once the run row exists (409 if one is already running)
 *   POST /api/stripe/webhook -> a signed Stripe event (payment_intent.succeeded by default) starts a run
 *   GET  /api/health        -> { ok, running, quota }
 *
 * Env: STRIPE_WEBHOOK_SECRET (whsec_..., from `stripe listen --print-secret`), DARWIN_TRIGGER_EVENT (default
 * payment_intent.succeeded), DARWIN_DRY=1 (log the trigger instead of starting a run; for testing without sandboxes).
 */
const cfg = loadConfig();
const db = new Db(cfg.databaseUrl);
const client = makeClient(cfg);

const app = express();

let activeRun: Promise<unknown> | null = null;

/** Start a race in the background and resolve with its run id once the run row exists. */
async function startRun(n: number): Promise<string | null> {
  const before = (await db.runState()).run?.id ?? null;
  activeRun = runRace({ cfg, client, db, n })
    .catch((e) => console.error("run failed:", (e as Error).message))
    .finally(() => { activeRun = null; });
  for (let i = 0; i < 50; i++) {
    const latest = (await db.runState()).run?.id ?? null;
    if (latest && latest !== before) return latest;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// Stripe signs the RAW body, so this route must be registered before express.json().
const stripe = new Stripe("sk_test_not_used_only_for_signature_verification");
const triggerEvent = process.env.DARWIN_TRIGGER_EVENT ?? "payment_intent.succeeded";
app.post("/api/stripe/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return void res.status(503).json({ error: "STRIPE_WEBHOOK_SECRET is not set; run `stripe listen --print-secret`" });
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body as Buffer, String(req.headers["stripe-signature"] ?? ""), secret);
  } catch (e) {
    return void res.status(400).json({ error: `signature verification failed: ${(e as Error).message}` });
  }
  if (event.type !== triggerEvent) return void res.json({ received: true, started: false, reason: `ignoring ${event.type}` });
  if (activeRun) return void res.json({ received: true, started: false, reason: "a run is already in progress" });
  if (process.env.DARWIN_DRY === "1") {
    console.log(`[dry] would start a run for Stripe event ${event.id} (${event.type})`);
    return void res.json({ received: true, started: false, reason: "dry run", eventId: event.id });
  }
  console.log(`Stripe event ${event.id} (${event.type}) is starting a run`);
  const runId = await startRun(3);
  res.json({ received: true, started: true, runId, eventId: event.id });
});

app.use(express.json());

// The UI runs on another origin in dev (Vite). Open CORS is fine: the API holds no secrets and only starts demo runs.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
});

app.get("/api/health", async (_req, res) => {
  try {
    res.json({ ok: true, running: activeRun !== null, quota: await quota(client) });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

app.get("/api/runs/latest", async (_req, res) => {
  try {
    res.json(await db.runState());
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get("/api/runs/:id", async (req, res) => {
  try {
    res.json(await db.runState(req.params.id));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post("/api/runs", async (req, res) => {
  if (activeRun) return void res.status(409).json({ error: "a run is already in progress" });
  const n = Math.min(4, Math.max(2, Number(req.body?.n ?? 3)));
  res.status(202).json({ runId: await startRun(n) });
});

const server = app.listen(cfg.port, () => console.log(`darwin orchestrator API on http://localhost:${cfg.port}`));
process.on("SIGINT", () => { server.close(); void db.close().finally(() => process.exit(0)); });
