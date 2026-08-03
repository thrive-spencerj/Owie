import type { Database } from "bun:sqlite";
import type { IngestPayload, Sample } from "./types";

const NUMBER_FIELDS = [
  "bms_serial",
  "uptime_s",
  "total_mv",
  "current_ma",
  "bms_soc",
  "overridden_soc",
  "voltage_soc",
  "status_byte",
  "used_mah",
  "regen_mah",
] as const;

export function validatePayload(
  body: unknown,
): { ok: true; payload: IngestPayload } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "payload must be a JSON object" };
  }
  const o = body as Record<string, unknown>;
  if (typeof o.chip_id !== "string" || o.chip_id.length === 0) {
    return { ok: false, error: "chip_id must be a non-empty string" };
  }
  if (typeof o.fw_version !== "string") {
    return { ok: false, error: "fw_version must be a string" };
  }
  if (typeof o.charging !== "boolean") {
    return { ok: false, error: "charging must be a boolean" };
  }
  for (const f of NUMBER_FIELDS) {
    if (typeof o[f] !== "number" || !Number.isFinite(o[f] as number)) {
      return { ok: false, error: `${f} must be a finite number` };
    }
  }
  const isNumArray = (v: unknown, len: number): v is number[] =>
    Array.isArray(v) &&
    v.length === len &&
    v.every((x) => typeof x === "number" && Number.isFinite(x));
  if (!isNumArray(o.cells_mv, 15)) {
    return { ok: false, error: "cells_mv must be an array of 15 numbers" };
  }
  if (!isNumArray(o.temps_c, 5)) {
    return { ok: false, error: "temps_c must be an array of 5 numbers" };
  }
  return { ok: true, payload: o as unknown as IngestPayload };
}

export function recordSample(
  db: Database,
  p: IngestPayload,
  ts: number,
): Sample {
  db.query(
    `INSERT INTO boards (chip_id, name, bms_serial, fw_version, first_seen, last_seen)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT(chip_id) DO UPDATE SET
       bms_serial = excluded.bms_serial,
       fw_version = excluded.fw_version,
       last_seen = excluded.last_seen`,
  ).run(
    p.chip_id,
    `Owie-${p.chip_id.toUpperCase()}`,
    p.bms_serial,
    p.fw_version,
    ts,
  );
  const res = db
    .query(
      `INSERT INTO samples (
         board_chip_id, ts, total_mv, current_ma, bms_soc, overridden_soc,
         voltage_soc, cells_mv, temps_c, charging, status_byte,
         used_mah, regen_mah, uptime_s
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      p.chip_id,
      ts,
      p.total_mv,
      p.current_ma,
      p.bms_soc,
      p.overridden_soc,
      p.voltage_soc,
      JSON.stringify(p.cells_mv),
      JSON.stringify(p.temps_c),
      p.charging ? 1 : 0,
      p.status_byte,
      p.used_mah,
      p.regen_mah,
      p.uptime_s,
    ) as { id: number };
  return { ...p, id: res.id, ts };
}
