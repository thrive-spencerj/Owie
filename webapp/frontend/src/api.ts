export interface Sample {
  id: number;
  ts: number;
  chip_id: string;
  uptime_s: number;
  total_mv: number;
  current_ma: number;
  bms_soc: number;
  overridden_soc: number;
  voltage_soc: number;
  cells_mv: number[];
  temps_c: number[];
  charging: boolean;
  status_byte: number;
  used_mah: number;
  regen_mah: number;
}

export interface Board {
  chip_id: string;
  name: string;
  bms_serial: number;
  fw_version: string;
  first_seen: number;
  last_seen: number;
  latest: Sample | null;
}

export interface Session {
  id: number;
  board_chip_id: string;
  kind: "ride" | "charge";
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
}

export interface Health {
  capacity_estimates: { session_id: number; ended_at: number; est_mah: number }[];
  capacity_est_mah: number | null;
  regen_ratio: number | null;
  cycle_count: number | null;
  temp_min_c: number | null;
  temp_max_c: number | null;
  cell_spread_daily: { day: string; max_spread_mv: number }[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchBoards = () => get<Board[]>("/api/boards");
export const fetchSamples = (chipId: string, from: number, to: number, res?: number) =>
  get<Sample[]>(
    `/api/boards/${chipId}/samples?from=${from}&to=${to}${res ? `&res=${res}` : ""}`,
  );
export const fetchSessions = (chipId: string) =>
  get<Session[]>(`/api/boards/${chipId}/sessions`);
export const fetchSessionDetail = (id: number) =>
  get<Session & { samples: Sample[] }>(`/api/sessions/${id}`);
export const fetchHealth = (chipId: string) =>
  get<Health>(`/api/boards/${chipId}/health`);
export const renameBoard = (chipId: string, name: string) =>
  fetch(`/api/boards/${chipId}`, { method: "PATCH", body: JSON.stringify({ name }) });
