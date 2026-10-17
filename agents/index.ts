import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import type { AgentApi, AttackReport, Patch, Verdict } from "../contracts/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.DARWIN_MODEL ?? "anthropic/claude-haiku-4.5";
const LLM_TIMEOUT_MS = 45_000;

// One distinct strategy per candidate, so the race has real variety (some fixes are subtly wrong on purpose).
const STRATEGIES = [
  "Simplest possible change: keep a Set of processed event ids; skip an event whose id is already in the Set, and add the id to the Set once the work has finished.",
  "Track in-flight work: put the event id in a Map/Set BEFORE any await so concurrent duplicates are dropped, and strictly validate the body (JSON, string id, numeric amount, string customer), answering 400 on bad input.",
  "Focus on input robustness: wrap parsing in try/catch, validate the payload and reply 4xx on bad input; for idempotency keep a Map from event id to a status and check it before doing the work.",
  "Database-style unique key: keep a Map keyed by event id acting like a UNIQUE constraint; insert the key atomically before the fulfillment await and return 200 for duplicates. Validate input and return 400 when malformed.",
];

const patchId = (i: number) => `patch-${String.fromCharCode(97 + i)}`;
const readFixture = (name: string): Patch => JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));

/** Known patches, used when the model fails. Alternates bad/good so a fallback race still has a mix. */
function fixturePatch(i: number): Patch {
  return { ...readFixture(i % 2 === 0 ? "bad-patch.json" : "good-patch.json"), id: patchId(i) };
}

async function chat(prompt: string, system: string): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY missing");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.8,
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("empty model response");
  return text;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return JSON.parse(start >= 0 ? body.slice(start, end + 1) : body);
}

/** Throws unless the model output is a usable patch for server.js. */
function validatePatch(raw: any, id: string): Patch {
  if (!raw || typeof raw.rationale !== "string" || !raw.files || typeof raw.files !== "object") throw new Error("bad shape");
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries<any>(raw.files)) {
    if (typeof content !== "string" || !content.trim()) throw new Error(`empty file ${path}`);
    if (path.startsWith("/") || path.includes("..")) throw new Error(`unsafe path ${path}`);
    if (path.endsWith(".js")) new Script(content, { filename: path }); // syntax check only, never executed here
    files[path] = content;
  }
  if (!files["server.js"]) throw new Error("patch must include server.js");
  if (!/listen\(/.test(files["server.js"])) throw new Error("server.js no longer listens");
  return { id, rationale: raw.rationale.trim().slice(0, 240), files };
}

async function oneModelPatch(i: number, input: { sourceFiles: Record<string, string>; bugReport: string }): Promise<Patch> {
  const system =
    "You are a senior Node.js engineer fixing a bug. Reply with ONLY a JSON object, no prose: " +
    '{"rationale": "<one or two sentences>", "files": {"server.js": "<the COMPLETE new file content>"}}. ' +
    "Keep it dependency-free (Node http only), CommonJS, listening on process.env.PORT || 8080 on 0.0.0.0, and keep the same endpoints.";
  const sources = Object.entries(input.sourceFiles).map(([p, c]) => `--- ${p} ---\n${c}`).join("\n\n");
  const prompt = `Bug report:\n${input.bugReport}\n\nService source:\n${sources}\n\nYour strategy for this fix: ${STRATEGIES[i % STRATEGIES.length]}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return validatePatch(extractJson(await chat(prompt, system)), patchId(i));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export async function generatePatches(input: { sourceFiles: Record<string, string>; bugReport: string; n: number }): Promise<Patch[]> {
  return Promise.all(
    Array.from({ length: input.n }, (_, i) =>
      oneModelPatch(i, input).catch((e) => {
        console.warn(`[agents] model patch ${i} failed (${(e as Error).message}); using fixture`);
        return fixturePatch(i);
      }),
    ),
  );
}

export async function getAttackScript(_input: { sourceFiles: Record<string, string> }): Promise<string> {
  return readFileSync(join(here, "attacks", "attack.js"), "utf8");
}

export async function judge(reports: AttackReport[]): Promise<Verdict[]> {
  return reports.map((r) => {
    const total = Math.max(1, r.results.length);
    const failed = r.results.filter((x) => !x.passed);
    const score = Math.round((100 * (total - failed.length)) / total);
    const reason = failed.length
      ? `Failed ${failed.length}/${total}: ${failed.map((f) => f.name).join(", ")}. ${failed[0].detail}`
      : `Survived all ${total} attacks.`;
    return { branchId: r.branchId, alive: failed.length === 0, score, reason };
  });
}

export const agents: AgentApi = { generatePatches, getAttackScript, judge };
