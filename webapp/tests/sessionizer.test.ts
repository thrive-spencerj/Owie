import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { recordSample } from "../src/ingest";
import {
  IDLE_TIMEOUT_MS,
  RIDE_THRESHOLD_MA,
  Sessionizer,
} from "../src/sessionizer";
import type { IngestPayload, SessionRow } from "../src/types";
import { makePayload } from "./ingest.test";

let db: Database;
let szr: Sessionizer;

function feed(ts: number, overrides: Partial<IngestPayload> = {}) {
  const s = recordSample(db, makePayload(overrides), ts);
  szr.onSample(s);
  return s;
}

function sessions(): SessionRow[] {
  return db
    .query<SessionRow, []>("SELECT * FROM sessions ORDER BY id")
    .all();
}

beforeEach(() => {
  db = openDb(":memory:");
  szr = new Sessionizer(db);
});

describe("charge sessions", () => {
  test("opens on charging=true and closes on charging=false", () => {
    feed(1000, { charging: true, current_ma: -2000, overridden_soc: 50 });
    let all = sessions();
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe("charge");
    expect(all[0].started_at).toBe(1000);
    expect(all[0].ended_at).toBeNull();
    expect(all[0].start_soc).toBe(50);

    feed(3000, { charging: true, current_ma: -2000, overridden_soc: 51 });
    feed(5000, { charging: false, overridden_soc: 51 });
    all = sessions();
    expect(all).toHaveLength(1);
    expect(all[0].ended_at).toBe(5000);
    expect(all[0].end_soc).toBe(51);
    expect(all[0].sample_count).toBe(2);
  });

  test("closes by idle timeout via sweep at last sample ts", () => {
    feed(1000, { charging: true });
    szr.sweep(1000 + IDLE_TIMEOUT_MS + 1);
    const s = sessions()[0];
    expect(s.ended_at).toBe(1000);
  });
});

describe("ride sessions", () => {
  test("opens only after 3 consecutive over-threshold samples, started_at = first", () => {
    feed(1000, { current_ma: 3000 });
    feed(3000, { current_ma: 3000 });
    expect(sessions()).toHaveLength(0);
    feed(5000, { current_ma: 3000 });
    const s = sessions();
    expect(s).toHaveLength(1);
    expect(s[0].kind).toBe("ride");
    expect(s[0].started_at).toBe(1000);
  });

  test("a sub-threshold sample resets the pending streak", () => {
    feed(1000, { current_ma: 3000 });
    feed(3000, { current_ma: 3000 });
    feed(5000, { current_ma: 100 });
    feed(7000, { current_ma: 3000 });
    feed(9000, { current_ma: 3000 });
    expect(sessions()).toHaveLength(0);
  });

  test("closes after 5 idle minutes with ended_at = last over-threshold ts", () => {
    feed(1000, { current_ma: 3000 });
    feed(3000, { current_ma: 3000 });
    feed(5000, { current_ma: 3000 });
    // Board sits still but keeps posting (idle cadence).
    feed(7000, { current_ma: 0 });
    feed(7000 + IDLE_TIMEOUT_MS + 1, { current_ma: 0 });
    const s = sessions()[0];
    expect(s.ended_at).toBe(5000);
  });

  test("charge start closes an open ride", () => {
    feed(1000, { current_ma: 3000 });
    feed(3000, { current_ma: 3000 });
    feed(5000, { current_ma: 3000 });
    feed(7000, { charging: true, current_ma: -2000 });
    const all = sessions();
    expect(all).toHaveLength(2);
    expect(all[0].kind).toBe("ride");
    expect(all[0].ended_at).toBe(7000);
    expect(all[1].kind).toBe("charge");
    expect(all[1].ended_at).toBeNull();
  });
});

describe("stats", () => {
  test("mah_delta, wh_delta, cell and temp extremes accumulate", () => {
    // Ride: 10A at ~58V for 10s (after session opens on 3rd sample).
    feed(1000, { current_ma: 10000, used_mah: 1000, regen_mah: 100 });
    feed(2000, { current_ma: 10000, used_mah: 1003, regen_mah: 100 });
    feed(3000, {
      current_ma: 10000,
      used_mah: 1006,
      regen_mah: 100,
      cells_mv: [3700, ...Array(13).fill(3866), 3900],
      temps_c: [18, 21, 20, 19, 25],
    });
    feed(13000, { current_ma: 10000, used_mah: 1034, regen_mah: 101 });
    const s = sessions()[0];
    // start counters come from the FIRST sample of the streak (used 1000/regen 100)
    expect(s.mah_delta).toBe(1034 - 1000 - (101 - 100));
    // wh integration from started_at (1000): 58V * 10A * 2s / 3600 = 0.322 Wh
    // (session-open update) + 58V * 10A * 10s / 3600 = 1.611 Wh => ~1.933 Wh
    expect(s.wh_delta).toBeGreaterThan(1.9);
    expect(s.wh_delta).toBeLessThan(2.0);
    expect(s.min_cell_mv).toBe(3700);
    expect(s.max_cell_mv).toBe(3900);
    expect(s.max_cell_spread_mv).toBe(200);
    expect(s.min_temp_c).toBe(18);
    expect(s.max_temp_c).toBe(25);
  });

  test("zero cells are ignored in cell stats", () => {
    feed(1000, { charging: true, cells_mv: [0, ...Array(14).fill(3866)] });
    const s = sessions()[0];
    expect(s.min_cell_mv).toBe(3866);
    expect(s.max_cell_spread_mv).toBe(0);
  });

  test("integration gap is capped at 60s", () => {
    feed(1000, { current_ma: 10000 });
    feed(2000, { current_ma: 10000 });
    feed(3000, { current_ma: 10000 });
    const before = sessions()[0].wh_delta;
    feed(3000 + 4 * 60_000, { current_ma: 10000 }); // 4-min gap, still < timeout
    const after = sessions()[0].wh_delta;
    // 58V * 10A * 60s(cap) / 3600 = 9.67 Wh max added
    expect(after - before).toBeLessThan(10);
  });
});

describe("startup adoption", () => {
  test("adoptOpenSessions closes stale sessions and keeps fresh ones", () => {
    feed(1000, { charging: true });
    const szr2 = new Sessionizer(db);
    szr2.adoptOpenSessions(1000 + IDLE_TIMEOUT_MS + 1);
    expect(sessions()[0].ended_at).toBe(1000);

    feed(10_000_000, { chip_id: "beef", charging: true });
    const szr3 = new Sessionizer(db);
    szr3.adoptOpenSessions(10_000_000 + 1000);
    const open = sessions().find((s) => s.board_chip_id === "beef")!;
    expect(open.ended_at).toBeNull();
    // and the adopted session keeps updating
    const s = recordSample(
      db,
      makePayload({ chip_id: "beef", charging: true }),
      10_002_000,
    );
    szr3.onSample(s);
    expect(
      sessions().find((x) => x.board_chip_id === "beef")!.sample_count,
    ).toBe(2);
  });
});
