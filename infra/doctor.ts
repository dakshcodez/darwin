import pg from "pg";
import { loadConfig } from "../orchestrator/config.js";
import { makeClient, quota } from "../orchestrator/createos.js";

let failed = 0;
const ok = (m: string) => console.log(`ok    ${m}`);
const bad = (m: string) => { failed++; console.log(`FAIL  ${m}`); };

try {
  const cfg = loadConfig();
  ok(`config loads, sandbox endpoint ${cfg.sandboxBaseUrl}`);
  cfg.openrouterApiKey ? ok("OPENROUTER_API_KEY present") : bad("OPENROUTER_API_KEY missing");

  try {
    const client = makeClient(cfg);
    const q = await quota(client);
    ok(`CreateOS auth works; sandboxes live=${q.live} (running ${q.running}, paused ${q.paused}), cap is 5`);
  } catch (e) { bad(`CreateOS: ${(e as Error).message}`); }

  try {
    const db = new pg.Client({ connectionString: cfg.databaseUrl, ssl: { rejectUnauthorized: false } });
    await db.connect();
    const { rows } = await db.query("select count(*)::int as n from runs");
    await db.end();
    ok(`Neon reachable, runs table has ${rows[0].n} rows`);
  } catch (e) { bad(`Neon: ${(e as Error).message}`); }
} catch (e) { bad((e as Error).message); }

process.exit(failed ? 1 : 0);
