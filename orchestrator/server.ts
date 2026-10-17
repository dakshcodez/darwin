import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import express from "express";
import Stripe from "stripe";
import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { makeClient, quota } from "./createos.js";
import { runRace } from "./race.js";
import { runCommandRace } from "./race-command.js";
import { EXAMPLES, loadTarget } from "./target.js";

/**
 * API for the UI (polled every second):
 *   GET  /api/runs/latest   -> RunState (latest run, its branches, attacks, events)
 *   GET  /api/runs/:id      -> RunState for one run
 *   POST /api/runs          -> start a run ({ n?, example?: "webhook" | "slugify" }), returns { runId } once the run row exists (409 if one is already running)
 *   POST /api/stripe/webhook -> a signed Stripe event (payment_intent.succeeded by default) starts a run
 *   GET  /api/health        -> { ok, running, quota }
 *
 * Protection (starting a race spends sandboxes and LLM quota, so it is gated):
 *   DARWIN_ADMIN_TOKEN       required in the `x-darwin-token` header to start a race. If unset: open on a developer machine,
 *                            refused when hosted (RENDER or NODE_ENV=production is set).
 *   DARWIN_MIN_INTERVAL_SEC  minimum seconds between race starts (default 240 when hosted, 0 locally).
 *   DARWIN_DRY=1             accept and rate-limit starts without creating anything (for tests).
 * Env: STRIPE_WEBHOOK_SECRET (whsec_..., from `stripe listen --print-secret`), DARWIN_TRIGGER_EVENT (default
 * payment_intent.succeeded), DARWIN_DRY=1 (log the trigger instead of starting a run; for testing without sandboxes).
 */
const cfg = loadConfig();
const db = new Db(cfg.databaseUrl);
const client = makeClient(cfg);

const app = express();
app.disable("x-powered-by");

const hosted = !!process.env.RENDER || process.env.NODE_ENV === "production";
const adminToken = process.env.DARWIN_ADMIN_TOKEN?.trim() || undefined;
const minIntervalMs = Number(process.env.DARWIN_MIN_INTERVAL_SEC ?? (hosted ? 240 : 0)) * 1000;
let lastStartAt = 0;

/** Constant-time check of the access token. With no token configured: open locally, closed when hosted. */
function tokenOk(given: unknown): boolean {
  if (!adminToken) return !hosted;
  const a = Buffer.from(String(given ?? "")), b = Buffer.from(adminToken);
  return a.length === b.length && timingSafeEqual(a, b);
}
const waitMs = () => Math.max(0, lastStartAt + minIntervalMs - Date.now());

let activeRun: Promise<unknown> | null = null;

/** Start a race in the background and resolve with its run id once the run row exists.
 *  `example` picks what to fix: the original webhook demo (attack suite) or a test-based example project. */
async function startRun(n: number, example?: string): Promise<string | null> {
  const before = (await db.runState()).run?.id ?? null;
  const job = example && example !== "webhook"
    ? runCommandRace({ cfg, client, db, target: loadTarget({ example, n }) })
    : runRace({ cfg, client, db, n });
  activeRun = job
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
  if (waitMs() > 0) return void res.json({ received: true, started: false, reason: `rate limited, next race in ${Math.ceil(waitMs() / 1000)}s` });
  if (process.env.DARWIN_DRY === "1") {
    console.log(`[dry] would start a run for Stripe event ${event.id} (${event.type})`);
    return void res.json({ received: true, started: false, reason: "dry run", eventId: event.id });
  }
  console.log(`Stripe event ${event.id} (${event.type}) is starting a run`);
  lastStartAt = Date.now();
  const runId = await startRun(3);
  res.json({ received: true, started: true, runId, eventId: event.id });
});

app.use(express.json());

// Local development: the UI may run on another origin (Vite). Hosted: same origin only, so no CORS headers at all.
app.use((req, res, next) => {
  if (!hosted) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type,x-darwin-token");
  }
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
  if (!tokenOk(req.headers["x-darwin-token"])) {
    return void res.status(adminToken ? 401 : 503).json({ error: adminToken ? "a valid access token is required to start a race" : "starting races is disabled on this server: DARWIN_ADMIN_TOKEN is not set" });
  }
  if (activeRun) return void res.status(409).json({ error: "a run is already in progress" });
  const n = Math.min(4, Math.max(2, Number(req.body?.n ?? 3)));
  const example = typeof req.body?.example === "string" ? req.body.example : undefined;
  if (example && !(example in EXAMPLES)) return void res.status(400).json({ error: `unknown example "${example}"; available: ${Object.keys(EXAMPLES).join(", ")}` });
  const wait = waitMs();
  if (wait > 0) {
    res.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
    return void res.status(429).json({ error: `rate limited: the next race can start in ${Math.ceil(wait / 1000)}s`, retryAfterSec: Math.ceil(wait / 1000) });
  }
  lastStartAt = Date.now();
  if (process.env.DARWIN_DRY === "1") return void res.status(202).json({ runId: null, dry: true });
  res.status(202).json({ runId: await startRun(n, example) });
});

app.use(express.static(path.join(cfg.rootDir, "ui")));
app.get("/", (_req, res) => res.sendFile(path.join(cfg.rootDir, "ui", "index.html")));
app.get("/arena", (_req, res) => res.sendFile(path.join(cfg.rootDir, "ui", "arena.html")));

const server = app.listen(cfg.port, () => console.log(`darwin orchestrator API on http://localhost:${cfg.port}`));
process.on("SIGINT", () => { server.close(); void db.close().finally(() => process.exit(0)); });
