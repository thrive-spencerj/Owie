import type { Database } from "bun:sqlite";
import type { Sample } from "./types";

export function parseSampleRow(row: any): Sample {
  return {
    id: row.id,
    ts: row.ts,
    chip_id: row.board_chip_id,
    bms_serial: 0, // per-board, lives on boards row
    fw_version: "",
    uptime_s: row.uptime_s,
    total_mv: row.total_mv,
    current_ma: row.current_ma,
    bms_soc: row.bms_soc,
    overridden_soc: row.overridden_soc,
    voltage_soc: row.voltage_soc,
    cells_mv: JSON.parse(row.cells_mv),
    temps_c: JSON.parse(row.temps_c),
    charging: !!row.charging,
    status_byte: row.status_byte,
    used_mah: row.used_mah,
    regen_mah: row.regen_mah,
  };
}

export function handleApi(
  db: Database,
  req: Request,
  url: URL,
): Response | Promise<Response> | undefined {
  const p = url.pathname;

  if (p === "/api/boards" && req.method === "GET") {
    const boards = db.query("SELECT * FROM boards ORDER BY name").all() as any[];
    const latestQ = db.query(
      "SELECT * FROM samples WHERE board_chip_id = ? ORDER BY ts DESC LIMIT 1",
    );
    return Response.json(
      boards.map((b) => {
        const row = latestQ.get(b.chip_id);
        return { ...b, latest: row ? parseSampleRow(row) : null };
      }),
    );
  }

  let m = p.match(/^\/api\/boards\/([^/]+)$/);
  if (m && req.method === "PATCH") {
    return patchBoard(db, req, m[1]);
  }

  m = p.match(/^\/api\/boards\/([^/]+)\/samples$/);
  if (m && req.method === "GET") {
    const from = Number(url.searchParams.get("from") ?? 0);
    const to = Number(url.searchParams.get("to") ?? Date.now());
    const res = Number(url.searchParams.get("res") ?? 0);
    let rows: any[];
    if (res > 0) {
      rows = db
        .query(
          `SELECT * FROM samples
           WHERE id IN (
             SELECT MAX(id) FROM samples
             WHERE board_chip_id = ?1 AND ts >= ?2 AND ts <= ?3
             GROUP BY ts / ?4
           )
           ORDER BY ts`,
        )
        .all(m[1], from, to, res);
    } else {
      rows = db
        .query(
          `SELECT * FROM samples
           WHERE board_chip_id = ?1 AND ts >= ?2 AND ts <= ?3 ORDER BY ts`,
        )
        .all(m[1], from, to);
    }
    return Response.json(rows.map(parseSampleRow));
  }

  m = p.match(/^\/api\/boards\/([^/]+)\/sessions$/);
  if (m && req.method === "GET") {
    const rows = db
      .query(
        "SELECT * FROM sessions WHERE board_chip_id = ? ORDER BY started_at DESC",
      )
      .all(m[1]);
    return Response.json(rows);
  }

  m = p.match(/^\/api\/sessions\/(\d+)$/);
  if (m && req.method === "GET") {
    const sess = db
      .query("SELECT * FROM sessions WHERE id = ?")
      .get(Number(m[1])) as any;
    if (!sess) return Response.json({ error: "not found" }, { status: 404 });
    const end = sess.ended_at ?? Date.now();
    const samples = db
      .query(
        `SELECT * FROM samples
         WHERE board_chip_id = ? AND ts >= ? AND ts <= ? ORDER BY ts`,
      )
      .all(sess.board_chip_id, sess.started_at, end)
      .map(parseSampleRow);
    return Response.json({ ...sess, samples });
  }

  m = p.match(/^\/api\/boards\/([^/]+)\/health$/);
  if (m && req.method === "GET") {
    return boardHealth(db, m[1]);
  }

  return undefined;
}

async function patchBoard(
  db: Database,
  req: Request,
  chipId: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const name = (body as { name?: unknown })?.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return Response.json({ error: "name required" }, { status: 400 });
  }
  const res = db
    .query("UPDATE boards SET name = ? WHERE chip_id = ?")
    .run(name.trim(), chipId);
  if (res.changes === 0) {
    return Response.json({ error: "unknown board" }, { status: 404 });
  }
  return Response.json({ ok: true });
}

function boardHealth(db: Database, chipId: string): Response {
  const chargeSessions = db
    .query(
      `SELECT id, ended_at, start_soc, end_soc, mah_delta
       FROM sessions
       WHERE board_chip_id = ? AND kind = 'charge' AND ended_at IS NOT NULL
         AND end_soc - start_soc >= 50
       ORDER BY ended_at`,
    )
    .all(chipId) as any[];
  const estimates = chargeSessions.map((s) => ({
    session_id: s.id,
    ended_at: s.ended_at,
    est_mah: Math.round((s.mah_delta / (s.end_soc - s.start_soc)) * 100),
  }));
  const sorted = estimates.map((e) => e.est_mah).sort((a, b) => a - b);
  const capacityEst = sorted.length
    ? sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : null;

  const latest = db
    .query(
      "SELECT used_mah, regen_mah FROM samples WHERE board_chip_id = ? ORDER BY ts DESC LIMIT 1",
    )
    .get(chipId) as any;
  const regenRatio =
    latest && latest.used_mah > 0 ? latest.regen_mah / latest.used_mah : null;
  const cycleCount =
    latest && capacityEst ? latest.used_mah / capacityEst : null;

  const temps = db
    .query(
      `SELECT MIN(min_temp_c) AS tmin, MAX(max_temp_c) AS tmax
       FROM sessions WHERE board_chip_id = ?`,
    )
    .get(chipId) as any;

  const spreadRows = db
    .query(
      `SELECT date(ts / 1000, 'unixepoch') AS day, cells_mv
       FROM samples WHERE board_chip_id = ? ORDER BY ts`,
    )
    .all(chipId) as any[];
  const byDay = new Map<string, number>();
  for (const r of spreadRows) {
    const cells = (JSON.parse(r.cells_mv) as number[]).filter((c) => c > 0);
    if (cells.length === 0) continue;
    const spread = Math.max(...cells) - Math.min(...cells);
    byDay.set(r.day, Math.max(byDay.get(r.day) ?? 0, spread));
  }

  return Response.json({
    capacity_estimates: estimates,
    capacity_est_mah: capacityEst,
    regen_ratio: regenRatio,
    cycle_count: cycleCount,
    temp_min_c: temps?.tmin ?? null,
    temp_max_c: temps?.tmax ?? null,
    cell_spread_daily: [...byDay.entries()].map(([day, max_spread_mv]) => ({
      day,
      max_spread_mv,
    })),
  });
}
