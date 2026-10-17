// Shared contracts between Part A (orchestrator) and Part B (agents, service, UI).
// Owner: Part A. Part B proposes changes, agrees first, then edits in the same commit as the code that needs it.

// ---------------------------------------------------------------------------
// Branch (one forked sandbox candidate) and run lifecycle
// ---------------------------------------------------------------------------

export type BranchStatus =
  | "forking" // fork requested, waiting for the sandbox
  | "patching" // patch being applied, service restarting
  | "attacking" // red team is attacking it
  | "killed" // judged and failed, being deleted or deleted
  | "survivor" // passed every attack
  | "promoted" // the chosen winner
  | "error"; // infrastructure failure (fork, push, restart), not a failed attack

export type RunStatus = "pending" | "running" | "done" | "error";

// ---------------------------------------------------------------------------
// Part B exports these (agents/index.ts). Part A calls them.
// ---------------------------------------------------------------------------

/** One candidate fix. Full replacement contents for each changed file. */
export interface Patch {
  id: string; // e.g. "patch-a"
  rationale: string; // one or two sentences, shown in the UI
  files: Record<string, string>; // path relative to /service (e.g. "server.js") -> full new file content
}

export interface AttackResult {
  name: string; // e.g. "concurrent-duplicates"
  passed: boolean; // true = the service survived this attack
  detail: string; // short human-readable evidence
}

/** Printed as JSON on the LAST line of stdout by attack.js. */
export interface AttackReport {
  branchId: string;
  results: AttackResult[];
  finishedAt: string; // ISO timestamp
}

export interface Verdict {
  branchId: string;
  alive: boolean;
  score: number; // 0-100
  reason: string; // one line, shown in the UI
}

export interface GeneratePatchesInput {
  sourceFiles: Record<string, string>; // /service files, path -> content
  bugReport: string;
  n: number;
}

export interface GetAttackScriptInput {
  sourceFiles: Record<string, string>; // the patched service files for the branch under attack
}

export interface AgentApi {
  generatePatches(input: GeneratePatchesInput): Promise<Patch[]>;
  /**
   * Returns Node.js source. The orchestrator pushes it to the red-team sandbox and runs
   * `node attack.js <TARGET_URL> <BRANCH_ID>`; it must print one AttackReport as JSON on the last stdout line.
   */
  getAttackScript(input: GetAttackScriptInput): Promise<string>;
  judge(reports: AttackReport[]): Promise<Verdict[]>;
}

// ---------------------------------------------------------------------------
// Demo service HTTP interface (Part B builds it, always on port 8080)
//   GET  /health              -> 200 { ok: true }
//   POST /webhook             -> 200, body: StripeLikeEvent
//   GET  /ledger              -> { entries: LedgerEntry[], total: number }
//   POST /reset               -> clears the ledger
//   start: `npm start` from the service directory
// ---------------------------------------------------------------------------

export interface StripeLikeEvent {
  id: string;
  type: "payment_intent.succeeded";
  data: { amount: number; customer: string };
}

export interface LedgerEntry {
  eventId: string;
  amount: number;
  customer: string;
}

// ---------------------------------------------------------------------------
// API served by the orchestrator, consumed by the UI (polled every 1 s)
//   GET  /api/runs/latest -> RunState
//   POST /api/runs        -> { runId: string }   starts a new run
// ---------------------------------------------------------------------------

export interface RunRow {
  id: string;
  status: RunStatus;
  created_at: string;
  winner_branch_id: string | null;
}

export interface BranchRow {
  id: string;
  run_id: string;
  parent_id: string | null; // the base sandbox's branch id, null for the base itself
  sandbox_id: string | null;
  sandbox_name: string | null;
  sandbox_ip: string | null;
  status: BranchStatus;
  patch_rationale: string | null;
  score: number | null;
  reason: string | null;
  created_at: string;
}

export interface AttackRow {
  id: number;
  branch_id: string;
  name: string;
  passed: boolean;
  detail: string;
}

export type EventKind =
  | "info"
  | "provision" // Stripe Projects / infrastructure setup
  | "fork"
  | "patch"
  | "attack"
  | "verdict"
  | "cleanup"
  | "error";

export interface EventRow {
  id: number;
  run_id: string;
  at: string;
  kind: EventKind;
  message: string;
}

export interface RunState {
  run: RunRow | null;
  branches: BranchRow[];
  attacks: AttackRow[];
  events: EventRow[];
}
