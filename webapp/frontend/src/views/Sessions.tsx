import { useEffect, useState } from "react";
import {
  fetchBoards,
  fetchSessionDetail,
  fetchSessions,
  type Board,
  type Sample,
  type Session,
} from "../api";
import TimeSeries from "../components/TimeSeries";

function fmtDuration(s: Session): string {
  if (!s.ended_at) return "ongoing";
  const mins = Math.round((s.ended_at - s.started_at) / 60_000);
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
}

export default function Sessions() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [boardFilter, setBoardFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [detail, setDetail] = useState<(Session & { samples: Sample[] }) | null>(null);

  useEffect(() => {
    fetchBoards().then(setBoards).catch(console.error);
  }, []);

  useEffect(() => {
    const targets = boardFilter
      ? [boardFilter]
      : boards.map((b) => b.chip_id);
    Promise.all(targets.map(fetchSessions))
      .then((lists) =>
        setSessions(
          lists.flat().sort((a, b) => b.started_at - a.started_at),
        ),
      )
      .catch(console.error);
  }, [boards, boardFilter]);

  const shown = sessions.filter((s) => !kindFilter || s.kind === kindFilter);
  const nameOf = (chip: string) =>
    boards.find((b) => b.chip_id === chip)?.name ?? chip;

  return (
    <div>
      <h1>Sessions</h1>
      <p>
        <select value={boardFilter} onChange={(e) => setBoardFilter(e.target.value)}>
          <option value="">All boards</option>
          {boards.map((b) => (
            <option key={b.chip_id} value={b.chip_id}>{b.name}</option>
          ))}
        </select>{" "}
        <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
          <option value="">Rides + charges</option>
          <option value="ride">Rides</option>
          <option value="charge">Charges</option>
        </select>
      </p>
      <div className="panel">
        <table className="sessions">
          <thead>
            <tr>
              <th>Board</th><th>Kind</th><th>Start</th><th>Duration</th>
              <th>SOC</th><th>mAh</th><th>Wh</th><th>Spread</th><th>Temp</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.id} onClick={() => fetchSessionDetail(s.id).then(setDetail)}
                  style={{ cursor: "pointer" }}>
                <td>{nameOf(s.board_chip_id)}</td>
                <td>{s.kind === "ride" ? "🛹 ride" : "🔌 charge"}</td>
                <td>{new Date(s.started_at).toLocaleString()}</td>
                <td>{fmtDuration(s)}</td>
                <td>{s.start_soc}% → {s.end_soc}%</td>
                <td>{Math.round(s.mah_delta)}</td>
                <td>{s.wh_delta.toFixed(1)}</td>
                <td>{s.max_cell_spread_mv ?? "—"} mV</td>
                <td>{s.min_temp_c ?? "—"}…{s.max_temp_c ?? "—"} °C</td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="placeholder">No sessions yet.</p>}
      </div>
      {detail && (
        <div className="panel">
          <h3>
            {detail.kind} on {nameOf(detail.board_chip_id)} —{" "}
            {new Date(detail.started_at).toLocaleString()}{" "}
            <button onClick={() => setDetail(null)}>close</button>
          </h3>
          <TimeSeries
            timestamps={detail.samples.map((x) => x.ts)}
            series={[
              { label: "Current (A)", stroke: "#f85149",
                values: detail.samples.map((x) => x.current_ma / 1000) },
              { label: "SOC (%)", stroke: "#3fb950",
                values: detail.samples.map((x) => x.overridden_soc) },
            ]}
          />
        </div>
      )}
    </div>
  );
}
