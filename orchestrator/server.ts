import express from "express";
import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { makeClient, quota } from "./createos.js";
import { runRace } from "./race.js";

/**
 * API for the UI (polled every second):
 *   GET  /api/runs/latest   -> RunState (latest run, its branches, attacks, events)
 *   GET  /api/runs/:id      -> RunState for one run
 *   POST /api/runs          -> start a run, returns { runId } once the run row exists (409 if one is already running)
 *   GET  /api/health        -> { ok, running, quota }
 */
const cfg = loadConfig();
const db = new Db(cfg.databaseUrl);
const client = makeClient(cfg);

const app = express();
app.use(express.json());

// The UI runs on another origin in dev (Vite). Open CORS is fine: the API holds no secrets and only starts demo runs.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
});

let activeRun: Promise<unknown> | null = null;

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
  // runRace creates the run row first thing; poll the latest run for its id so the UI can follow along.
  const before = (await db.runState()).run?.id ?? null;
  activeRun = runRace({ cfg, client, db, n })
    .catch((e) => console.error("run failed:", (e as Error).message))
    .finally(() => { activeRun = null; });
  for (let i = 0; i < 50; i++) {
    const latest = (await db.runState()).run?.id ?? null;
    if (latest && latest !== before) return void res.status(202).json({ runId: latest });
    await new Promise((r) => setTimeout(r, 200));
  }
  res.status(202).json({ runId: null });
});

const server = app.listen(cfg.port, () => console.log(`darwin orchestrator API on http://localhost:${cfg.port}`));
process.on("SIGINT", () => { server.close(); void db.close().finally(() => process.exit(0)); });
