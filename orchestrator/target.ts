import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A "target" is any project Darwin should fix: where the code is, what is broken, and how to tell a fix is good.
 * Sources: a local directory, a public git URL, or the built-in webhook example. A `darwin.json` file in the project
 * can hold the settings; CLI flags override it.
 */

export interface Target {
  name: string;
  dir: string; // absolute path of the project on this machine
  bug: string;
  /** "command": run `test` inside every fork (bring your own tests). "http-attack": the built-in webhook demo. */
  mode: "command" | "http-attack";
  test?: string; // command mode, e.g. "npm test"
  install?: string; // run once in the base sandbox before it is snapshotted, e.g. "npm ci"
  /** Hosts a fork may reach while its tests run. Default: none (the fork is fully locked down). */
  egress: string[];
  n: number; // candidate fixes
  timeoutSec: number; // per-fork test timeout
  /** Files the model may rewrite. "auto" = every source file that is not a test. */
  editable: string[] | "auto";
}

export interface TargetInput {
  path?: string; // local dir or git URL
  example?: string; // built-in example name
  bug?: string;
  test?: string;
  install?: string;
  n?: number;
  timeoutSec?: number;
  editable?: string[];
  egress?: string[];
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

export const EXAMPLES: Record<string, Partial<Target> & { dir: string; name: string }> = {
  slugify: { name: "slugify", dir: path.join(ROOT, "examples", "slugify") },
  // The original demo: a buggy Stripe webhook service, attacked over HTTP from a red-team sandbox.
  webhook: {
    name: "webhook",
    dir: path.join(ROOT, "service"),
    mode: "http-attack",
    bug:
      "The webhook handler double-processes duplicate Stripe events (same event id) and crashes on malformed bodies. " +
      "Make fulfillment idempotent per event id, including when duplicates arrive concurrently, and reject malformed bodies with 4xx.",
  },
};

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".venv", "venv", "__pycache__", ".darwin", "target", "coverage", ".cache"]);
const IGNORE_FILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|poetry\.lock|Cargo\.lock|\.DS_Store|\.env.*)$/;
const TEXT_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|json|py|go|rs|java|rb|php|c|h|cpp|cs|sh|md|yml|yaml|toml|txt|html|css|sql)$/i;
const TEST_PATH = /(^|\/)(test|tests|__tests__|spec|specs)(\/|$)|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/i;

export function isTestPath(p: string): boolean {
  return TEST_PATH.test(p);
}

/** Resolve a git URL to a temporary local clone (shallow). Only public repos: no credentials are used. */
function cloneRepo(url: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "darwin-clone-"));
  execFileSync("git", ["clone", "--depth", "1", "--quiet", url, dir], { stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 });
  return dir;
}

export function loadTarget(input: TargetInput): Target {
  let base: Partial<Target> & { dir?: string; name?: string } = {};
  if (input.example) {
    const ex = EXAMPLES[input.example];
    if (!ex) throw new Error(`unknown example "${input.example}". Available: ${Object.keys(EXAMPLES).join(", ")}`);
    base = { ...ex };
  } else if (input.path) {
    const isUrl = /^(https?:\/\/|git@)/.test(input.path);
    base = { dir: isUrl ? cloneRepo(input.path) : path.resolve(input.path) };
    base.name = path.basename(isUrl ? input.path.replace(/\.git$/, "") : base.dir!);
  } else {
    throw new Error("give a project path or git URL, or --example <name>");
  }
  const dir = base.dir!;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);

  // darwin.json in the project, if present; explicit flags win over it
  let fromFile: Partial<Target> = {};
  const specPath = path.join(dir, "darwin.json");
  if (existsSync(specPath)) {
    try { fromFile = JSON.parse(readFileSync(specPath, "utf8")); }
    catch (e) { throw new Error(`darwin.json is not valid JSON: ${(e as Error).message}`); }
  }

  const merged: Target = {
    name: String(fromFile.name ?? base.name ?? path.basename(dir)),
    dir,
    mode: (base.mode ?? fromFile.mode ?? "command") as Target["mode"],
    bug: input.bug?.trim() || fromFile.bug || base.bug || "",
    test: input.test?.trim() || fromFile.test || base.test,
    install: input.install?.trim() || fromFile.install || base.install,
    egress: input.egress ?? fromFile.egress ?? [],
    n: input.n ?? fromFile.n ?? 3,
    timeoutSec: input.timeoutSec ?? fromFile.timeoutSec ?? 120,
    editable: input.editable ?? fromFile.editable ?? "auto",
  };
  if (!merged.bug.trim()) throw new Error("describe the bug: --bug \"what is broken\" (or put \"bug\" in darwin.json)");
  if (merged.mode === "command" && !merged.test) throw new Error("give a test command that fails now and should pass once fixed: --test \"npm test\" (or put \"test\" in darwin.json)");
  merged.n = Math.min(4, Math.max(2, merged.n));
  return merged;
}

export interface Sources {
  editable: Record<string, string>; // files the model may rewrite (path relative to the project)
  context: Record<string, string>; // read-only files shown to the model (tests, configs)
  skipped: string[]; // files left out (too big, binary, over budget)
}

const MAX_FILE = 60_000; // bytes per file
const MAX_TOTAL = 140_000; // bytes sent to the model in total

/** Collect the project's text files, split into "may edit" and "read only", within a context budget. */
export function collectSources(target: Target): Sources {
  const all: { rel: string; size: number }[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(target.dir, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(path.join(target.dir, r));
      if (st.isDirectory()) { if (!IGNORE_DIRS.has(name) && !name.startsWith(".")) walk(r); }
      else if (!IGNORE_FILES.test(r) && TEXT_EXT.test(r) && name !== "darwin.json") all.push({ rel: r, size: st.size });
    }
  };
  walk("");

  const explicit = target.editable === "auto" ? null : new Set(target.editable.map((e) => e.replace(/^\.\//, "")));
  const editable: Record<string, string> = {};
  const context: Record<string, string> = {};
  const skipped: string[] = [];
  let total = 0;
  // source files first, then tests and other context, so the budget never starves the files we need to edit
  const ordered = [...all].sort((a, b) => Number(isTestPath(a.rel)) - Number(isTestPath(b.rel)) || a.size - b.size);
  for (const f of ordered) {
    if (f.size > MAX_FILE || total + f.size > MAX_TOTAL) { skipped.push(f.rel); continue; }
    const text = readFileSync(path.join(target.dir, f.rel), "utf8");
    if (text.includes("\0")) { skipped.push(f.rel); continue; }
    total += f.size;
    const mayEdit = explicit ? explicit.has(f.rel) : !isTestPath(f.rel) && !/(^|\/)(package\.json|README[^/]*|LICENSE[^/]*)$/i.test(f.rel);
    (mayEdit ? editable : context)[f.rel] = text;
  }
  if (!Object.keys(editable).length) throw new Error("no editable source files found (check --editable or the project layout)");
  return { editable, context, skipped };
}
