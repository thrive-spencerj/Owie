export interface IngestPayload {
  chip_id: string;
  bms_serial: number;
  fw_version: string;
  uptime_s: number;
  total_mv: number;
  current_ma: number; // signed; positive = discharge
  bms_soc: number;
  overridden_soc: number;
  voltage_soc: number;
  cells_mv: number[]; // exactly 15
  temps_c: number[]; // exactly 5
  charging: boolean;
  status_byte: number;
  used_mah: number; // cumulative, monotonic (NVS-backed fuel gauge)
  regen_mah: number; // cumulative, monotonic
}

export interface Sample extends IngestPayload {
  id: number;
  ts: number; // epoch ms, server-assigned
}

export interface BoardRow {
  chip_id: string;
  name: string;
  bms_serial: number;
  fw_version: string;
  first_seen: number;
  last_seen: number;
}

export type SessionKind = "ride" | "charge";

export interface SessionRow {
  id: number;
  board_chip_id: string;
  kind: SessionKind;
  started_at: number;
  ended_at: number | null;
  start_soc: number;
  end_soc: number;
  mah_delta: number;
  wh_delta: number;
  min_cell_mv: number | null;
  max_cell_mv: number | null;
  max_cell_spread_mv: number | null;
  min_temp_c: number | null;
  max_temp_c: number | null;
  sample_count: number;
  start_used_mah: number;
  start_regen_mah: number;
  last_sample_ts: number;
  last_active_ts: number;
}
