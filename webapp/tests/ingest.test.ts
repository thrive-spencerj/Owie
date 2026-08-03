import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { recordSample, validatePayload } from "../src/ingest";
import type { IngestPayload } from "../src/types";

export function makePayload(
  overrides: Partial<IngestPayload> = {},
): IngestPayload {
  return {
    chip_id: "c024",
    bms_serial: 12345,
    fw_version: "2.0.0-dev",
    uptime_s: 60,
    total_mv: 58000,
    current_ma: 0,
    bms_soc: 80,
    overridden_soc: 82,
    voltage_soc: 81,
    cells_mv: Array(15).fill(3866),
    temps_c: [20, 21, 20, 19, 20],
    charging: false,
    status_byte: 0,
    used_mah: 1000,
    regen_mah: 100,
    ...overrides,
  };
}

describe("validatePayload", () => {
  test("accepts a well-formed payload", () => {
    const r = validatePayload(makePayload());
    expect(r.ok).toBe(true);
  });

  test("rejects missing fields, wrong array lengths, bad types", () => {
    const missing: Record<string, unknown> = { ...makePayload() };
    delete missing.total_mv;
    expect(validatePayload(missing).ok).toBe(false);
    expect(validatePayload(makePayload({ cells_mv: Array(14).fill(3866) })).ok).toBe(false);
    expect(validatePayload(makePayload({ temps_c: [1, 2, 3] })).ok).toBe(false);
    expect(validatePayload({ ...makePayload(), current_ma: "5" }).ok).toBe(false);
    expect(validatePayload(null).ok).toBe(false);
    expect(validatePayload("hi").ok).toBe(false);
  });
});

describe("recordSample", () => {
  test("auto-creates the board with default name and inserts the sample", () => {
    const db = openDb(":memory:");
    const s = recordSample(db, makePayload(), 1000);
    expect(s.id).toBeGreaterThan(0);
    expect(s.ts).toBe(1000);
    const board = db
      .query("SELECT * FROM boards WHERE chip_id = 'c024'")
      .get() as any;
    expect(board.name).toBe("Owie-C024");
    expect(board.first_seen).toBe(1000);
    const row = db.query("SELECT * FROM samples").get() as any;
    expect(JSON.parse(row.cells_mv)).toHaveLength(15);
  });

  test("second sample updates last_seen/fw/serial but not first_seen or name", () => {
    const db = openDb(":memory:");
    recordSample(db, makePayload(), 1000);
    db.exec("UPDATE boards SET name = 'Floaty' WHERE chip_id = 'c024'");
    recordSample(db, makePayload({ fw_version: "2.0.1", bms_serial: 999 }), 2000);
    const board = db
      .query("SELECT * FROM boards WHERE chip_id = 'c024'")
      .get() as any;
    expect(board.first_seen).toBe(1000);
    expect(board.last_seen).toBe(2000);
    expect(board.fw_version).toBe("2.0.1");
    expect(board.bms_serial).toBe(999);
    expect(board.name).toBe("Floaty");
  });
});
