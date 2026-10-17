import type { BranchRow, RunState } from "../contracts/types.js";

/**
 * Terminal rendering for the Darwin CLI. No dependencies: plain ANSI escapes and box-drawing characters.
 * `frame()` turns a RunState (the same snapshot the web UI polls) into a block of lines; the caller redraws it in place.
 */

const useColor = !process.env.NO_COLOR;
const esc = (code: string) => (useColor ? `\x1b[${code}m` : "");
const RESET = esc("0");
const rgb = (r: number, g: number, b: number) => esc(`38;2;${r};${g};${b}`);
export const c = {
  bold: (s: string) => `${esc("1")}${s}${RESET}`,
  dim: (s: string) => `${esc("2")}${s}${RESET}`,
  white: (s: string) => `${rgb(235, 238, 245)}${s}${RESET}`,
  gray: (s: string) => `${rgb(130, 138, 156)}${s}${RESET}`,
  blue: (s: string) => `${rgb(96, 145, 255)}${s}${RESET}`,
  cyan: (s: string) => `${rgb(80, 220, 235)}${s}${RESET}`,
  green: (s: string) => `${rgb(70, 220, 130)}${s}${RESET}`,
  amber: (s: string) => `${rgb(255, 184, 64)}${s}${RESET}`,
  red: (s: string) => `${rgb(255, 98, 98)}${s}${RESET}`,
  violet: (s: string) => `${rgb(176, 128, 255)}${s}${RESET}`,
};

const ANSI = /\x1b\[[0-9;]*m/g;
export const strip = (s: string) => s.replace(ANSI, "");
const vlen = (s: string) => strip(s).length;
const padEnd = (s: string, w: number) => s + " ".repeat(Math.max(0, w - vlen(s)));
const center = (s: string, w: number) => { const l = Math.max(0, w - vlen(s)); return " ".repeat(l >> 1) + s + " ".repeat(l - (l >> 1)); };
function clip(s: string, w: number): string {
  if (vlen(s) <= w) return s;
  let out = "", n = 0;
  for (let i = 0; i < s.length && n < w - 1; ) {
    const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (m) { out += m[0]; i += m[0].length; } else { out += s[i]; i++; n++; }
  }
  return out + "…" + RESET;
}
function wrap(text: string, width: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width) { lines.push(cur); cur = w; } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = clip(lines[maxLines - 1] + "…", width); }
  return lines;
}

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const spin = (f: number) => SPIN[f % SPIN.length];

interface Chip { label: string; color: (s: string) => string; icon: string; dim: boolean }
function chip(b: BranchRow, f: number): Chip {
  switch (b.status) {
    case "forking": return { label: "CLONING MICRO-VM", color: c.violet, icon: spin(f), dim: false };
    case "patching": return { label: "APPLYING PATCH", color: c.blue, icon: spin(f), dim: false };
    case "attacking": return { label: "RUNNING TESTS", color: c.amber, icon: spin(f), dim: false };
    case "killed": return { label: "ELIMINATED", color: c.red, icon: "✖", dim: true };
    case "survivor": return { label: "SURVIVED", color: c.green, icon: "✔", dim: false };
    case "promoted": return { label: "PROMOTED", color: (s) => c.bold(c.green(s)), icon: "★", dim: false };
    default: return { label: "ERROR", color: c.red, icon: "!", dim: true };
  }
}

function bar(score: number | null, width: number, f: number, active: boolean, color: (s: string) => string): string {
  if (score === null) {
    if (!active) return c.gray("░".repeat(width));
    const pos = f % (width * 2 - 2);
    const p = pos < width ? pos : width * 2 - 2 - pos;
    return Array.from({ length: width }, (_, i) => (Math.abs(i - p) < 3 ? c.amber("█") : c.gray("░"))).join("");
  }
  const filled = Math.round((score / 100) * width);
  return color("█".repeat(filled)) + c.gray("░".repeat(width - filled));
}

function box(lines: string[], width: number, title: string, border: (s: string) => string): string[] {
  const inner = width - 2;
  const head = `╭─ ${title} ` ;
  const top = border(head + "─".repeat(Math.max(0, width - vlen(head) - 1)) + "╮");
  const body = lines.map((l) => border("│") + padEnd(" " + clip(l, inner - 2) + " ", inner) + border("│"));
  return [top, ...body, border("╰" + "─".repeat(inner) + "╯")];
}

function joinColumns(cols: string[][], gap: number): string[] {
  const h = Math.max(...cols.map((x) => x.length));
  const w = cols.map((x) => Math.max(...x.map(vlen)));
  return Array.from({ length: h }, (_, r) => cols.map((col, i) => padEnd(col[r] ?? "", w[i])).join(" ".repeat(gap)));
}

export interface FrameContext {
  targetName: string;
  testCmd?: string;
  bug?: string;
  startedAt: number;
  frame: number;
  cols: number;
  endpoint: string;
  model?: string;
}

export function frame(state: RunState | null, ctx: FrameContext): string[] {
  const W = Math.max(78, Math.min(ctx.cols - 2, 124));
  const f = ctx.frame;
  const out: string[] = [];
  const bannerInner = W - 2;
  out.push(c.blue("╭" + "─".repeat(bannerInner) + "╮"));
  out.push(c.blue("│") + center(`${c.bold(c.white("◆ D A R W I N"))}   ${c.gray("natural selection for agent-written code")}`, bannerInner) + c.blue("│"));
  out.push(c.blue("╰" + "─".repeat(bannerInner) + "╯"));

  const elapsed = Math.floor((Date.now() - ctx.startedAt) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(1, "0"), ss = String(elapsed % 60).padStart(2, "0");
  const label = (k: string) => c.gray(k.padEnd(9));
  out.push(`${label("target")}${c.white(ctx.targetName)}${ctx.testCmd ? c.gray("  ·  tests: ") + c.cyan(ctx.testCmd) : ""}${" ".repeat(2)}${c.gray(`⏱ ${mm}:${ss}`)}`);
  if (ctx.bug) for (const [i, l] of wrap(ctx.bug, W - 10, 2).entries()) out.push(`${i === 0 ? label("bug") : " ".repeat(9)}${c.dim(c.white(l))}`);
  out.push(`${label("sandbox")}${c.gray("CreateOS Firecracker micro-VMs  ·  ")}${c.gray(ctx.endpoint.replace(/^https?:\/\//, ""))}${ctx.model ? c.gray("  ·  model ") + c.gray(ctx.model) : ""}`);
  const stack = state?.events.find((e) => e.kind === "provision" && e.message.startsWith("Stripe Projects stack"));
  if (stack) {
    const names = [...stack.message.matchAll(/(\w+)\/(\w+) \(complete\)/g)].map((m) => `${m[1].toLowerCase()}/${m[2]} ${c.green("✔")}`);
    out.push(`${label("stack")}${c.gray("Stripe Projects  ·  ")}${names.join("  ") || c.gray("provisioned")}`);
  }
  out.push("");

  if (!state || !state.run) {
    out.push(`  ${c.amber(spin(f))} ${c.white("preparing the run…")}`);
    return out;
  }

  // base sandbox
  const base = state.branches.find((b) => !b.parent_id);
  const cands = state.branches.filter((b) => b.parent_id);
  const baseAttack = base ? state.attacks.find((a) => a.branch_id === base.id) : undefined;
  const baseState = cands.length ? `${c.violet("❄")} ${c.gray("paused snapshot, RAM and processes captured")}` : `${c.violet(spin(f))} ${c.gray("booting and loading the project…")}`;
  const baseLines = [
    `${c.white(base?.sandbox_name ?? "base sandbox")}  ${c.gray(base?.sandbox_ip ?? "")}`,
    baseState,
    baseAttack ? `${c.red("✖")} ${c.gray("baseline: " + baseAttack.detail)}` : c.gray("running the baseline tests…"),
  ];
  const bw = Math.min(W - 6, 64);
  for (const l of box(baseLines, bw, c.bold(c.blue("BASE SANDBOX")), c.blue)) out.push(center(l, W));

  if (cands.length) {
    out.push(center(c.gray("│"), W));
    const gap = 2;
    const cw = Math.max(26, Math.min(44, Math.floor((W - gap * (cands.length - 1)) / cands.length)));
    out.push(center(c.gray("┌" + "─".repeat(Math.min(W - 10, (cw + gap) * cands.length - gap - 2)) + "┐"), W));
    const cards = cands.map((b, i) => {
      const ch = chip(b, f);
      const border = b.status === "promoted" ? (s: string) => c.bold(c.green(s)) : ch.dim ? c.gray : b.status === "attacking" ? c.amber : b.status === "survivor" ? c.green : c.violet;
      const mine = state.attacks.filter((a) => a.branch_id === b.id);
      const detail = mine[0]?.detail ?? "";
      const inner = cw - 4;
      const lines = [
        `${ch.color(ch.icon)} ${ch.color(ch.label)}`,
        `${c.white(clip(b.sandbox_name ?? "…", inner))}`,
        c.gray(b.sandbox_ip ?? "provisioning…"),
        "",
        ...wrap(b.patch_rationale ?? (b.status === "forking" ? "forking from the paused snapshot…" : "model is writing a candidate fix…"), inner, 3).map((l) => ch.dim ? c.gray(l) : c.white(l)),
        ...Array(Math.max(0, 3 - wrap(b.patch_rationale ?? "x", inner, 3).length)).fill(""),
        "",
        `${bar(b.score, Math.min(inner - 6, 22), f, b.status === "attacking", b.score === 100 ? c.green : b.score === null ? c.amber : c.red)} ${b.score === null ? c.gray("  …") : (b.score === 100 ? c.green : c.red)(String(b.score).padStart(3))}`,
        detail ? (ch.dim ? c.gray(clip(detail, inner)) : c.gray(clip(detail, inner))) : c.gray(b.status === "attacking" ? "executing the test suite…" : " "),
      ];
      return box(lines, cw, `${c.bold(c.white("FIX " + String.fromCharCode(65 + i)))}`, border);
    });
    for (const l of joinColumns(cards, gap)) out.push(center(l, W));
  }

  // verdict banner
  const winner = cands.find((b) => b.status === "promoted");
  if (state.run.status === "done") {
    out.push("");
    out.push(winner
      ? `  ${c.bold(c.green("★ " + (winner.sandbox_name ?? winner.id) + " promoted"))}${c.gray("  ·  " + cands.filter((b) => b.status === "killed").length + " eliminated  ·  untrusted code never touched this machine")}`
      : `  ${c.bold(c.red("✖ no candidate survived"))}${c.gray("  ·  nothing promoted")}`);
  } else if (state.run.status === "error") {
    out.push("");
    out.push(`  ${c.bold(c.red("✖ run failed"))} ${c.gray("see the event feed below")}`);
  }

  // event feed
  out.push("");
  out.push(c.gray("  events"));
  const kindColor: Record<string, (s: string) => string> = { provision: c.blue, fork: c.violet, patch: c.cyan, attack: c.amber, verdict: c.green, cleanup: c.gray, error: c.red, info: c.gray };
  for (const e of state.events.slice(-7)) {
    const t = new Date(e.at).toLocaleTimeString("en-GB");
    const col = kindColor[e.kind] ?? c.gray;
    out.push(`  ${c.gray(t)}  ${col(e.kind.toUpperCase().padEnd(9))}${clip(c.white(e.message), W - 24)}`);
  }
  return out;
}
