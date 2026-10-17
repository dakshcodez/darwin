import "dotenv/config";
import { Script } from "node:vm";
import type { AttackReport, Patch, Verdict } from "../contracts/types.js";
import { isTestPath, type Sources, type Target } from "./target.js";

/**
 * Agents for the "bring your own code" mode. The webhook demo keeps using agents/index.ts; this module works for any
 * project: the builder sees the bug, the failing test output and the source files, and the judge is test-based.
 * It talks to any OpenAI-compatible endpoint (OPENROUTER_BASE_URL / OPENROUTER_API_KEY / DARWIN_MODEL), which is how
 * we use Google's Gemini free tier.
 */

// DARWIN_MODELS = comma-separated models tried in order; DARWIN_MODEL is the single-model fallback. Google's free tier
// allows only 20 requests per day PER MODEL, so when one is exhausted we rotate to the next.
const MODELS = () => (process.env.DARWIN_MODELS ?? process.env.DARWIN_MODEL ?? "gemini-3.7-flash").split(",").map((m) => m.trim()).filter(Boolean);
const BASE = () => process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
const LLM_TIMEOUT_MS = 90_000;
const exhausted = new Set<string>(); // models that hit their daily quota during this process

const STRATEGIES = [
  "Make the smallest change that fixes the root cause.",
  "Fix the root cause and make the code defensive: handle edge cases and odd inputs, including ones the visible tests do not cover.",
  "Rewrite the faulty logic cleanly with a different approach than the obvious one (a different algorithm or a standard-library helper), keeping the public interface exactly the same.",
  "Read the failing test output line by line and fix exactly the cases it shows, then double-check the other cases you can infer from the bug report.",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function chat(system: string, user: string): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("no LLM key: set OPENROUTER_API_KEY (and OPENROUTER_BASE_URL / DARWIN_MODEL) in .env");
  const models = MODELS().filter((m) => !exhausted.has(m));
  if (!models.length) throw new Error(`every configured model hit its daily quota (${MODELS().join(", ")}); add models to DARWIN_MODELS or wait`);
  let lastErr = "";
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${BASE().replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model, temperature: 0.8, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
      if (res.ok) {
        const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const text = json.choices?.[0]?.message?.content;
        if (text) return text;
        lastErr = `${model}: empty response`;
        break;
      }
      const body = await res.text();
      lastErr = `${model}: HTTP ${res.status} ${body.replace(/\s+/g, " ").slice(0, 120)}`;
      if (res.status === 429) {
        if (/PerDay|per day/i.test(body)) { exhausted.add(model); break; } // daily quota gone: next model
        const wait = Number(body.match(/retry in (\d+(?:\.\d+)?)s/i)?.[1] ?? 12); // per-minute limit: wait it out once
        await sleep(Math.min(25, wait + 1) * 1000);
        continue;
      }
      break; // other errors: try the next model
    }
  }
  throw new Error(lastErr || "LLM call failed");
}

function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return JSON.parse(start >= 0 ? body.slice(start, end + 1) : body);
}

/** Throws unless the model output is a usable patch for this project. */
function validatePatch(raw: any, id: string, editable: Record<string, string>): Patch {
  if (!raw || typeof raw.rationale !== "string" || !raw.files || typeof raw.files !== "object") throw new Error("bad shape");
  const files: Record<string, string> = {};
  for (const [p, content] of Object.entries<any>(raw.files)) {
    const rel = p.replace(/^\.\//, "");
    if (typeof content !== "string" || !content.trim()) throw new Error(`empty file ${rel}`);
    if (rel.startsWith("/") || rel.includes("..")) throw new Error(`unsafe path ${rel}`);
    if (isTestPath(rel)) throw new Error(`patch modifies a test file (${rel})`);
    if (!(rel in editable) && /(^|\/)(package\.json|darwin\.json)$/.test(rel)) throw new Error(`patch edits ${rel}, which is off limits`);
    if (/\.(c|m)?js$/.test(rel) && !/^\s*(import|export)\s/m.test(content)) {
      try { new Script(`(function(exports,require,module,__filename,__dirname){${content}\n})`, { filename: rel }); }
      catch (e) { throw new Error(`syntax error in ${rel}: ${(e as Error).message}`); }
    }
    files[rel] = content;
  }
  if (!Object.keys(files).length) throw new Error("no files in patch");
  return { id, rationale: raw.rationale.trim().slice(0, 240), files };
}

export interface GenericInput {
  target: Target;
  sources: Sources;
  failingOutput: string; // test output from the unmodified project
  n: number;
}

const patchId = (i: number) => `patch-${String.fromCharCode(97 + i)}`;

async function oneCandidate(i: number, inp: GenericInput): Promise<Patch> {
  const system =
    "You are a senior software engineer fixing a bug. Reply with ONLY a JSON object, no prose and no code fences: " +
    '{"rationale": "<one or two sentences>", "files": {"<relative path>": "<the COMPLETE new content of that file>"}}. ' +
    "Include only files you change, using exactly the paths listed under EDITABLE FILES. Never modify tests. " +
    "Keep public function names and signatures. Do not add dependencies.";
  const block = (title: string, files: Record<string, string>) =>
    `${title}\n` + Object.entries(files).map(([p, c]) => `--- ${p} ---\n${c}`).join("\n\n");
  const user = [
    `BUG REPORT:\n${inp.target.bug}`,
    `TEST COMMAND (must pass after your fix): ${inp.target.test}`,
    `CURRENT TEST OUTPUT (failing):\n${inp.failingOutput.slice(-3500)}`,
    block("EDITABLE FILES:", inp.sources.editable),
    Object.keys(inp.sources.context).length ? block("READ-ONLY CONTEXT (do not modify):", inp.sources.context) : "",
    `YOUR STRATEGY FOR THIS ATTEMPT: ${STRATEGIES[i % STRATEGIES.length]}`,
  ].filter(Boolean).join("\n\n");
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return validatePatch(extractJson(await chat(system, user)), patchId(i), inp.sources.editable); }
    catch (e) { lastErr = e; }
  }
  return { id: patchId(i), rationale: `(no valid patch: ${(lastErr as Error).message.slice(0, 120)})`, files: {} };
}

/** Candidates are generated in parallel. A candidate that could not be produced has empty `files`. */
export async function generatePatchesGeneric(inp: GenericInput): Promise<Patch[]> {
  return Promise.all(Array.from({ length: inp.n }, async (_, i) => { await sleep(i * 800); return oneCandidate(i, inp); }));
}

// ---------------------------------------------------------------------------
// Test output parsing and judging
// ---------------------------------------------------------------------------

export interface TestCounts { pass: number; fail: number; total: number }

/** Best-effort pass/fail counts from node:test / TAP, jest and pytest style summaries. */
export function parseTestCounts(output: string): TestCounts | null {
  const num = (re: RegExp) => { const m = output.match(re); return m ? Number(m[1]) : null; };
  const nodePass = num(/^(?:ℹ|#) pass (\d+)/m), nodeFail = num(/^(?:ℹ|#) fail (\d+)/m);
  if (nodePass !== null && nodeFail !== null) return { pass: nodePass, fail: nodeFail, total: nodePass + nodeFail };
  const jest = output.match(/Tests:\s+(?:(\d+) failed,\s*)?(?:(\d+) skipped,\s*)?(?:(\d+) passed,\s*)?(\d+) total/);
  if (jest) { const fail = Number(jest[1] ?? 0), pass = Number(jest[3] ?? 0); return { pass, fail, total: Number(jest[4]) }; }
  const py = num(/(\d+) passed/), pyFail = num(/(\d+) failed/);
  if (py !== null || pyFail !== null) return { pass: py ?? 0, fail: pyFail ?? 0, total: (py ?? 0) + (pyFail ?? 0) };
  return null;
}

/** Turn one test run into the AttackReport shape the rest of Darwin (database, judge, UI) already understands. */
export function reportFromTestRun(branchId: string, exitCode: number, output: string): AttackReport {
  const counts = parseTestCounts(output);
  const tail = output.trim().split("\n").slice(-3).join(" ").slice(0, 200);
  const results = [
    {
      name: "test-suite",
      passed: exitCode === 0,
      detail: counts ? `${counts.pass}/${counts.total} tests pass (exit ${exitCode})` : `exit code ${exitCode}. ${tail}`,
    },
  ];
  if (counts && counts.fail > 0) results.push({ name: "failing-tests", passed: false, detail: `${counts.fail} test(s) still fail` });
  return { branchId, results, finishedAt: new Date().toISOString() };
}

export async function judgeGeneric(reports: AttackReport[]): Promise<Verdict[]> {
  return reports.map((r) => {
    const suite = r.results.find((x) => x.name === "test-suite");
    const m = suite?.detail.match(/(\d+)\/(\d+) tests pass/);
    const alive = !!suite?.passed;
    const score = alive ? 100 : m && Number(m[2]) > 0 ? Math.round((100 * Number(m[1])) / Number(m[2])) : 0;
    return { branchId: r.branchId, alive, score, reason: alive ? "All tests pass." : suite?.detail ?? "tests did not pass" };
  });
}
