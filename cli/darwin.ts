import { parseArgs } from "node:util";
import type { RunState } from "../contracts/types.js";
import { loadConfig } from "../orchestrator/config.js";
import { Db } from "../orchestrator/db.js";
import { destroyAllOurs, makeClient, quota } from "../orchestrator/createos.js";
import { runRace } from "../orchestrator/race.js";
import { runCommandRace } from "../orchestrator/race-command.js";
import { EXAMPLES, loadTarget } from "../orchestrator/target.js";
import { c, frame, strip } from "./render.js";

const HELP = `
${c.bold(c.white("darwin"))} ${c.gray("natural selection for agent-written code")}

${c.bold("usage")}
  darwin run <path|git-url> --bug "what is broken" --test "npm test" [options]
  darwin run --example slugify            ${c.gray("a tiny project with failing tests")}
  darwin run --example webhook            ${c.gray("the original demo: a buggy Stripe webhook service, attacked over HTTP")}
  darwin status                           ${c.gray("show the latest run")}
  darwin examples                         ${c.gray("list the built-in examples")}
  darwin cleanup                          ${c.gray("destroy leftover sandboxes")}

${c.bold("options for run")}
  --bug <text>        what is broken (or "bug" in darwin.json)
  --test <command>    command that fails now and passes once fixed (or "test" in darwin.json)
  --install <command> run once before the snapshot, e.g. "npm ci"
  -n, --candidates N  candidate fixes to race (2-4, default 3)
  --egress <host>     host a fork may reach while testing (repeatable; default: none)
  --apply             write the winning files into your project (default: save a patch under .darwin/)
  --plain             no live view, print events as they happen

${c.bold("how it works")}
  your code is copied into a CreateOS sandbox, snapshotted and forked. A model writes a different fix in each fork,
  every fork is locked off from the internet, and your own tests decide which fix survives.
`;

const write = (s: string) => process.stdout.write(s);
const isTTY = !!process.stdout.isTTY && !process.env.CI;
const modelName = () => (process.env.DARWIN_MODELS ?? process.env.DARWIN_MODEL ?? "").split(",")[0]?.trim() || undefined;

function colorDiff(diff: string): string {
  return diff.split("\n").map((l) => (l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ") ? c.gray(l) : l.startsWith("+") ? c.green(l) : l.startsWith("-") ? c.red(l) : l.startsWith("@@") ? c.cyan(l) : c.white(l))).join("\n");
}

async function cmdRun(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      example: { type: "string" }, bug: { type: "string" }, test: { type: "string" }, install: { type: "string" },
      candidates: { type: "string", short: "n" }, egress: { type: "string", multiple: true },
      apply: { type: "boolean" }, plain: { type: "boolean" },
    },
  });
  const target = loadTarget({
    path: positionals[0], example: values.example, bug: values.bug, test: values.test, install: values.install,
    n: values.candidates ? Number(values.candidates) : undefined, egress: values.egress,
  });
  if (target.mode === "http-attack") process.env.DARWIN_AGENTS = "real"; // the webhook demo uses Part B's agents

  const cfg = loadConfig();
  const db = new Db(cfg.databaseUrl);
  const client = makeClient(cfg);
  const started = Date.now();
  let runId: string | null = null;
  let state: RunState | null = null;
  let frameNo = 0, lastLines = 0, lastPoll = 0, polling = false, lastEvent = 0;
  const live = isTTY && !values.plain;

  const ctx = () => ({
    targetName: target.name, testCmd: target.mode === "command" ? target.test : undefined, bug: target.bug,
    startedAt: started, frame: frameNo++, cols: process.stdout.columns ?? 100, endpoint: cfg.sandboxBaseUrl, model: modelName(),
  });
  const poll = async () => {
    if (!runId || polling || Date.now() - lastPoll < 700) return;
    polling = true; lastPoll = Date.now();
    try { state = await db.runState(runId); } catch { /* keep the previous snapshot */ } finally { polling = false; }
    if (!live && state) for (const e of state.events) if (Number(e.id) > lastEvent) { console.log(`${new Date(e.at).toLocaleTimeString("en-GB")}  ${e.kind.toUpperCase().padEnd(9)} ${e.message}`); lastEvent = Number(e.id); }
  };
  const draw = (final = false) => {
    const lines = frame(state, ctx());
    write((lastLines ? `\x1b[${lastLines}A\x1b[J` : "") + lines.join("\n") + "\n");
    lastLines = lines.length;
    if (final) write("\x1b[?25h");
  };
  if (live) { write("\x1b[?25l"); draw(); }
  const timer = setInterval(() => { void poll(); if (live) draw(); }, 120);
  process.on("SIGINT", () => { write("\x1b[?25h\n"); console.log(c.amber("interrupted. Run `darwin cleanup` to remove any sandboxes left running.")); process.exit(130); });

  let result: { winnerBranchId: string | null; diff?: string | null; patchDir?: string | null } | null = null;
  let failure: Error | null = null;
  try {
    result = target.mode === "command"
      ? await runCommandRace({ cfg, client, db, target, apply: values.apply, onRunId: (id) => { runId = id; } })
      : await runRace({ cfg, client, db, n: target.n, serviceDir: target.dir, bugReport: target.bug, onRunId: (id) => { runId = id; } });
  } catch (e) { failure = e as Error; }
  if (runId) state = await db.runState(runId).catch(() => state);
  clearInterval(timer);
  if (live) draw(true);
  else if (state) { lastEvent = lastEvent; for (const e of state.events) if (Number(e.id) > lastEvent) console.log(`${new Date(e.at).toLocaleTimeString("en-GB")}  ${e.kind.toUpperCase().padEnd(9)} ${e.message}`); }

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log("");
  if (failure) { console.log(`${c.bold(c.red("✖ run failed"))}  ${c.white(failure.message)}`); await db.close(); process.exit(1); }
  if (result?.winnerBranchId) {
    const win = state?.branches.find((b) => b.id === result!.winnerBranchId);
    console.log(`${c.bold(c.green("★ winner"))}  ${c.white(win?.sandbox_name ?? result.winnerBranchId)}  ${c.gray(`score ${win?.score ?? "?"} · ${secs}s`)}`);
    if (win?.patch_rationale) console.log(`${c.gray("idea")}    ${c.white(win.patch_rationale)}`);
    if (result.diff) {
      console.log("\n" + colorDiff(result.diff));
      console.log(values.apply ? `${c.green("✔")} applied to ${target.dir}` : `${c.gray("saved")}   ${result.patchDir}/winner.patch   ${c.gray("(re-run with --apply to write it into your project)")}`);
    }
  } else {
    console.log(`${c.bold(c.red("✖ no candidate survived"))}  ${c.gray(`${secs}s · nothing promoted`)}`);
  }
  await db.close();
  process.exit(result?.winnerBranchId ? 0 : 1);
}

async function cmdStatus() {
  const cfg = loadConfig();
  const db = new Db(cfg.databaseUrl);
  const state = await db.runState();
  await db.close();
  if (!state.run) { console.log("no runs yet"); return; }
  console.log(frame(state, { targetName: `run ${state.run.id}`, startedAt: Date.now(), frame: 0, cols: process.stdout.columns ?? 100, endpoint: cfg.sandboxBaseUrl, model: modelName() }).join("\n"));
}

async function cmdCleanup() {
  const client = makeClient(loadConfig({ requireDb: false }));
  console.log(c.gray("before:"), JSON.stringify(await quota(client)));
  const r = await destroyAllOurs(client);
  console.log(`destroyed ${r.destroyed.length} sandbox(es), ${r.networks.length} network(s)`);
  console.log(c.gray("after: "), JSON.stringify(await quota(client)));
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "run") await cmdRun(rest);
  else if (cmd === "status") await cmdStatus();
  else if (cmd === "cleanup") await cmdCleanup();
  else if (cmd === "examples") for (const [k, v] of Object.entries(EXAMPLES)) console.log(`  ${c.cyan(k.padEnd(10))}${c.gray(v.dir)}`);
  else console.log(HELP);
} catch (e) {
  console.error(`${c.red("error:")} ${strip((e as Error).message)}`);
  process.exit(1);
}
process.exit(0);
