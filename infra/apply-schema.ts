import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { loadConfig } from "../orchestrator/config.js";

const cfg = loadConfig();
const sql = await readFile(path.join(cfg.rootDir, "contracts", "schema.sql"), "utf8");
const client = new pg.Client({ connectionString: cfg.databaseUrl, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query(sql);
  const { rows } = await client.query(
    "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
  );
  console.log("schema applied. tables:", rows.map((r) => r.table_name).join(", "));
} finally {
  await client.end();
}
