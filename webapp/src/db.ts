import { Database } from "bun:sqlite";

export function openDb(
  path: string = process.env.OWIE_DB ?? "owie.db",
): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS boards (
      chip_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      bms_serial INTEGER NOT NULL DEFAULT 0,
      fw_version TEXT NOT NULL DEFAULT '',
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_chip_id TEXT NOT NULL REFERENCES boards(chip_id),
      ts INTEGER NOT NULL,
      total_mv INTEGER NOT NULL,
      current_ma INTEGER NOT NULL,
      bms_soc INTEGER NOT NULL,
      overridden_soc INTEGER NOT NULL,
      voltage_soc INTEGER NOT NULL,
      cells_mv TEXT NOT NULL,
      temps_c TEXT NOT NULL,
      charging INTEGER NOT NULL,
      status_byte INTEGER NOT NULL,
      used_mah INTEGER NOT NULL,
      regen_mah INTEGER NOT NULL,
      uptime_s INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_samples_board_ts
      ON samples(board_chip_id, ts);
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_chip_id TEXT NOT NULL REFERENCES boards(chip_id),
      kind TEXT NOT NULL CHECK (kind IN ('ride','charge')),
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      start_soc INTEGER NOT NULL,
      end_soc INTEGER NOT NULL,
      mah_delta REAL NOT NULL DEFAULT 0,
      wh_delta REAL NOT NULL DEFAULT 0,
      min_cell_mv INTEGER,
      max_cell_mv INTEGER,
      max_cell_spread_mv INTEGER,
      min_temp_c INTEGER,
      max_temp_c INTEGER,
      sample_count INTEGER NOT NULL DEFAULT 0,
      start_used_mah INTEGER NOT NULL,
      start_regen_mah INTEGER NOT NULL,
      last_sample_ts INTEGER NOT NULL,
      last_active_ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_board
      ON sessions(board_chip_id, started_at);
  `);
  return db;
}
