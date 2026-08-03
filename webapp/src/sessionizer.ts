import type { Database } from "bun:sqlite";
import type { Sample, SessionRow } from "./types";

export const RIDE_THRESHOLD_MA = 500;
export const RIDE_CONSECUTIVE = 3;
export const IDLE_TIMEOUT_MS = 5 * 60_000;
export const MAX_INTEGRATION_GAP_MS = 60_000;

interface PendingRide {
  count: number;
  first: Sample;
}

export class Sessionizer {
  private pendingRide = new Map<string, PendingRide>();

  constructor(private db: Database) {}

  onSample(s: Sample): void {
    const open = this.getOpenSession(s.chip_id);
    if (s.charging) {
      this.pendingRide.delete(s.chip_id);
      if (open?.kind === "ride") this.close(open, s.ts);
      const charge =
        open?.kind === "charge" ? open : this.openSession("charge", s, s);
      this.update(charge, s, /*active=*/ true);
      return;
    }
    if (open?.kind === "charge") {
      this.close(open, s.ts);
    } else if (open?.kind === "ride") {
      const active = s.current_ma > RIDE_THRESHOLD_MA;
      if (!active && s.ts - open.last_active_ts > IDLE_TIMEOUT_MS) {
        this.close(open, open.last_active_ts);
      } else {
        this.update(open, s, active);
      }
      return;
    }
    // No open session: track the pending ride streak.
    if (s.current_ma > RIDE_THRESHOLD_MA) {
      const p = this.pendingRide.get(s.chip_id);
      const next: PendingRide = p
        ? { count: p.count + 1, first: p.first }
        : { count: 1, first: s };
      if (next.count >= RIDE_CONSECUTIVE) {
        this.pendingRide.delete(s.chip_id);
        const ride = this.openSession("ride", next.first, s);
        this.update(ride, s, /*active=*/ true);
      } else {
        this.pendingRide.set(s.chip_id, next);
      }
    } else {
      this.pendingRide.delete(s.chip_id);
    }
  }

  /** Close any open session that has heard nothing for the idle timeout. */
  sweep(now: number): void {
    const open = this.db
      .query<SessionRow, []>("SELECT * FROM sessions WHERE ended_at IS NULL")
      .all();
    for (const sess of open) {
      if (now - sess.last_sample_ts > IDLE_TIMEOUT_MS) {
        this.close(
          sess,
          sess.kind === "ride" ? sess.last_active_ts : sess.last_sample_ts,
        );
      }
    }
  }

  /** Startup reconciliation: same rule as sweep. */
  adoptOpenSessions(now: number): void {
    this.sweep(now);
  }

  private getOpenSession(chipId: string): SessionRow | null {
    return (
      this.db
        .query<SessionRow, [string]>(
          "SELECT * FROM sessions WHERE board_chip_id = ? AND ended_at IS NULL",
        )
        .get(chipId) ?? null
    );
  }

  /** `first` provides started_at and start counters; `current` is the sample being processed. */
  private openSession(
    kind: "ride" | "charge",
    first: Sample,
    current: Sample,
  ): SessionRow {
    const row = this.db
      .query<SessionRow, [string, string, number, number, number, number, number, number, number]>(
        `INSERT INTO sessions (
           board_chip_id, kind, started_at, start_soc, end_soc,
           start_used_mah, start_regen_mah, last_sample_ts, last_active_ts
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      // last_sample_ts starts at started_at so the first update() integrates
      // from the true beginning of the session.
      .get(
        first.chip_id,
        kind,
        first.ts,
        first.overridden_soc,
        first.overridden_soc,
        first.used_mah,
        first.regen_mah,
        first.ts,
        first.ts,
      ) as unknown as SessionRow;
    void current;
    return row;
  }

  private update(sess: SessionRow, s: Sample, active: boolean): void {
    const dtMs = Math.min(
      Math.max(s.ts - sess.last_sample_ts, 0),
      MAX_INTEGRATION_GAP_MS,
    );
    const whAdd =
      ((s.total_mv / 1000) * (Math.abs(s.current_ma) / 1000) * (dtMs / 1000)) /
      3600;
    const usedDelta = s.used_mah - sess.start_used_mah;
    const regenDelta = s.regen_mah - sess.start_regen_mah;
    const mahDelta =
      sess.kind === "ride" ? usedDelta - regenDelta : regenDelta - usedDelta;

    const liveCells = s.cells_mv.filter((c) => c > 0);
    const minCell = liveCells.length ? Math.min(...liveCells) : null;
    const maxCell = liveCells.length ? Math.max(...liveCells) : null;
    const spread =
      minCell !== null && maxCell !== null ? maxCell - minCell : null;
    const minTemp = Math.min(...s.temps_c);
    const maxTemp = Math.max(...s.temps_c);

    this.db
      .query(
        `UPDATE sessions SET
           end_soc = ?,
           mah_delta = ?,
           wh_delta = wh_delta + ?,
           min_cell_mv = MIN(COALESCE(min_cell_mv, 1000000), COALESCE(?, 1000000)),
           max_cell_mv = MAX(COALESCE(max_cell_mv, -1), COALESCE(?, -1)),
           max_cell_spread_mv = MAX(COALESCE(max_cell_spread_mv, -1), COALESCE(?, -1)),
           min_temp_c = MIN(COALESCE(min_temp_c, 1000), ?),
           max_temp_c = MAX(COALESCE(max_temp_c, -1000), ?),
           sample_count = sample_count + 1,
           last_sample_ts = ?,
           last_active_ts = ?
         WHERE id = ?`,
      )
      .run(
        s.overridden_soc,
        mahDelta,
        whAdd,
        minCell,
        maxCell,
        spread,
        minTemp,
        maxTemp,
        s.ts,
        active ? s.ts : sess.last_active_ts,
        sess.id,
      );
  }

  private close(sess: SessionRow, endedAt: number): void {
    this.db
      .query("UPDATE sessions SET ended_at = ? WHERE id = ?")
      .run(endedAt, sess.id);
  }
}
