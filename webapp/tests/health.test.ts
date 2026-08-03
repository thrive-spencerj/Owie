import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleApi } from "../src/api";
import { openDb } from "../src/db";
import { recordSample } from "../src/ingest";
import { makePayload } from "./ingest.test";

let db: Database;
beforeEach(() => {
  db = openDb(":memory:");
});

function seedChargeSession(opts: {
  startSoc: number;
  endSoc: number;
  mah: number;
  endedAt: number;
}) {
  db.query(
    `INSERT INTO sessions (board_chip_id, kind, started_at, ended_at, start_soc, end_soc,
      mah_delta, start_used_mah, start_regen_mah, last_sample_ts, last_active_ts,
      min_temp_c, max_temp_c)
     VALUES ('c024','charge', ?1 - 1000, ?1, ?2, ?3, ?4, 0, 0, ?1, ?1, 10, 35)`,
  ).run(opts.endedAt, opts.startSoc, opts.endSoc, opts.mah);
}

async function health(): Promise<any> {
  const url = new URL("http://x/api/boards/c024/health");
  const res = await handleApi(db, new Request(url), url)!;
  expect(res.status).toBe(200);
  return res.json();
}

describe("GET /api/boards/:chipId/health", () => {
  test("capacity from >=50% swing charge sessions, median, cycles, regen ratio", async () => {
    recordSample(db, makePayload({ used_mah: 30000, regen_mah: 3000 }), 5000);
    seedChargeSession({ startSoc: 10, endSoc: 90, mah: 12000, endedAt: 2000 }); // est 15000
    seedChargeSession({ startSoc: 20, endSoc: 80, mah: 7800, endedAt: 3000 }); // est 13000
    seedChargeSession({ startSoc: 60, endSoc: 90, mah: 4000, endedAt: 4000 }); // swing 30, ignored
    const h = await health();
    expect(h.capacity_estimates).toHaveLength(2);
    expect(h.capacity_est_mah).toBe(14000); // median of [13000, 15000]
    expect(h.regen_ratio).toBeCloseTo(0.1);
    expect(h.cycle_count).toBeCloseTo(30000 / 14000, 2);
    expect(h.temp_min_c).toBe(10);
    expect(h.temp_max_c).toBe(35);
  });

  test("nulls when there is no usable data", async () => {
    recordSample(db, makePayload({ used_mah: 0, regen_mah: 0 }), 1000);
    const h = await health();
    expect(h.capacity_est_mah).toBeNull();
    expect(h.cycle_count).toBeNull();
    expect(h.regen_ratio).toBeNull();
  });

  test("daily max cell spread", async () => {
    const day1 = Date.UTC(2026, 7, 1, 12); // 2026-08-01
    const day2 = Date.UTC(2026, 7, 2, 12);
    recordSample(db, makePayload({ cells_mv: [3800, ...Array(13).fill(3850), 3860] }), day1);
    recordSample(db, makePayload({ cells_mv: [3810, ...Array(13).fill(3850), 3855] }), day1 + 1000);
    recordSample(db, makePayload({ cells_mv: [3700, ...Array(13).fill(3850), 3900] }), day2);
    const h = await health();
    expect(h.cell_spread_daily).toEqual([
      { day: "2026-08-01", max_spread_mv: 60 },
      { day: "2026-08-02", max_spread_mv: 200 },
    ]);
  });
});
