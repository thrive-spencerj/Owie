import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { recordSample, validatePayload } from "../src/ingest";

// Byte-identical to the golden string asserted by the firmware's native
// serializer test (test/test_telemetry_serializer). If either side changes,
// both tests must change together.
const FIRMWARE_GOLDEN_JSON =
  '{"chip_id":"c024","bms_serial":123456,"fw_version":"test-fw",' +
  '"uptime_s":60,"total_mv":58000,"current_ma":1000,"bms_soc":80,' +
  '"overridden_soc":82,"voltage_soc":81,"cells_mv":[3866,3866,3866,3866,' +
  "3866,3866,3866,3866,3866,3866,3866,3866,3866,3866,3866]," +
  '"temps_c":[20,21,20,19,20],"charging":false,"status_byte":0,' +
  '"used_mah":1000,"regen_mah":100}';

describe("firmware serializer contract", () => {
  test("the firmware golden payload passes validation and records", () => {
    const body = JSON.parse(FIRMWARE_GOLDEN_JSON);
    const v = validatePayload(body);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const db = openDb(":memory:");
    const sample = recordSample(db, v.payload, 1000);
    expect(sample.id).toBeGreaterThan(0);
    const board = db
      .query("SELECT name FROM boards WHERE chip_id = 'c024'")
      .get() as any;
    expect(board.name).toBe("Owie-C024");
  });
});
