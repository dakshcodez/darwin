import pg from "pg";
import type { AttackReport, BranchRow, BranchStatus, EventKind, RunState, RunStatus } from "../contracts/types.js";

/**
 * Neon access for run history. Every state change goes through here so the UI (polling /api/runs/latest)
 * and the README story both read from one source of truth.
 */
export class Db {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 4 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createRun(id: string): Promise<void> {
    await this.pool.query("insert into runs (id, status) values ($1, 'pending')", [id]);
  }

  async setRunStatus(id: string, status: RunStatus, winnerBranchId?: string | null): Promise<void> {
    await this.pool.query("update runs set status = $2, winner_branch_id = coalesce($3, winner_branch_id) where id = $1", [
      id,
      status,
      winnerBranchId ?? null,
    ]);
  }

  async upsertBranch(b: {
    id: string;
    runId: string;
    parentId?: string | null;
    sandboxId?: string | null;
    sandboxName?: string | null;
    sandboxIp?: string | null;
    status: BranchStatus;
    patchRationale?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `insert into branches (id, run_id, parent_id, sandbox_id, sandbox_name, sandbox_ip, status, patch_rationale)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (id) do update set
         sandbox_id = coalesce(excluded.sandbox_id, branches.sandbox_id),
         sandbox_name = coalesce(excluded.sandbox_name, branches.sandbox_name),
         sandbox_ip = coalesce(excluded.sandbox_ip, branches.sandbox_ip),
         status = excluded.status,
         patch_rationale = coalesce(excluded.patch_rationale, branches.patch_rationale)`,
      [b.id, b.runId, b.parentId ?? null, b.sandboxId ?? null, b.sandboxName ?? null, b.sandboxIp ?? null, b.status, b.patchRationale ?? null],
    );
  }

  async setBranchStatus(id: string, status: BranchStatus): Promise<void> {
    await this.pool.query("update branches set status = $2 where id = $1", [id, status]);
  }

  async setBranchVerdict(id: string, status: BranchStatus, score: number, reason: string): Promise<void> {
    await this.pool.query("update branches set status = $2, score = $3, reason = $4 where id = $1", [id, status, score, reason]);
  }

  async saveAttacks(report: AttackReport): Promise<void> {
    await this.pool.query("delete from attacks where branch_id = $1", [report.branchId]);
    for (const r of report.results) {
      await this.pool.query("insert into attacks (branch_id, name, passed, detail) values ($1,$2,$3,$4)", [
        report.branchId,
        r.name,
        r.passed,
        r.detail,
      ]);
    }
  }

  async event(runId: string, kind: EventKind, message: string): Promise<void> {
    console.log(`[${kind}] ${message}`);
    await this.pool.query("insert into events (run_id, kind, message) values ($1,$2,$3)", [runId, kind, message]).catch((e) => {
      console.error("event insert failed:", (e as Error).message);
    });
  }

  /** Snapshot for the UI. Uses the latest run, or a specific one. */
  async runState(runId?: string): Promise<RunState> {
    const runRes = runId
      ? await this.pool.query("select * from runs where id = $1", [runId])
      : await this.pool.query("select * from runs order by created_at desc limit 1");
    const run = runRes.rows[0];
    if (!run) return { run: null, branches: [], attacks: [], events: [] };
    const [branches, attacks, events] = await Promise.all([
      this.pool.query("select * from branches where run_id = $1 order by created_at, id", [run.id]),
      this.pool.query("select a.* from attacks a join branches b on b.id = a.branch_id where b.run_id = $1 order by a.id", [run.id]),
      this.pool.query("select * from events where run_id = $1 order by id", [run.id]),
    ]);
    return {
      run: { id: run.id, status: run.status, created_at: run.created_at.toISOString(), winner_branch_id: run.winner_branch_id },
      branches: branches.rows.map((r): BranchRow => ({ ...r, created_at: r.created_at.toISOString() })),
      attacks: attacks.rows,
      events: events.rows.map((r) => ({ ...r, at: r.at.toISOString() })),
    };
  }
}
