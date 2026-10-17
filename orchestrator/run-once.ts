// Run one race from the terminal: `npm run race`. Uses stub agents unless DARWIN_AGENTS=real.
import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { makeClient } from "./createos.js";
import { runRace } from "./race.js";

const cfg = loadConfig();
const db = new Db(cfg.databaseUrl);
const client = makeClient(cfg);
const started = Date.now();
try {
  const r = await runRace({ cfg, client, db, n: Number(process.env.DARWIN_N ?? 3) });
  console.log(`\nrun ${r.runId} finished in ${((Date.now() - started) / 1000).toFixed(1)}s; winner: ${r.winnerBranchId ?? "none"}`);
  process.exitCode = 0;
} catch (e) {
  console.error("run failed:", (e as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
  process.exit();
}
