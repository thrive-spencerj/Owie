import { useEffect, useMemo, useState } from "react";
import {
  fetchBoards,
  fetchHealth,
  fetchSamples,
  renameBoard,
  type Board,
  type Health,
  type Sample,
} from "../api";
import { useLiveSamples } from "../live";
import CellBars from "../components/CellBars";
import TimeSeries from "../components/TimeSeries";

const RANGES: Record<string, number> = {
  "1h": 3600_000,
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
};
const CELL_COLORS = [
  "#4f8ef7", "#f78f4f", "#3fb950", "#d29922", "#f85149",
  "#a371f7", "#39c5cf", "#db61a2", "#8ddb61", "#e3b341",
  "#6e7681", "#58a6ff", "#f0883e", "#56d364", "#ff7b72",
];

export default function BoardDetail({ chipId }: { chipId: string }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [latest, setLatest] = useState<Sample | null>(null);
  const [history, setHistory] = useState<Sample[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [range, setRange] = useState("24h");

  useEffect(() => {
    fetchBoards()
      .then((bs) => {
        const b = bs.find((x) => x.chip_id === chipId) ?? null;
        setBoard(b);
        setLatest(b?.latest ?? null);
      })
      .catch(console.error);
    fetchHealth(chipId).then(setHealth).catch(console.error);
  }, [chipId]);

  useEffect(() => {
    const to = Date.now();
    const from = to - RANGES[range];
    // Aim for <= ~1000 points via bucketing.
    const res = Math.max(0, Math.floor(RANGES[range] / 1000 / 1000) * 1000);
    fetchSamples(chipId, from, to, res).then(setHistory).catch(console.error);
  }, [chipId, range]);

  useLiveSamples((s) => {
    if (s.chip_id !== chipId) return;
    setLatest(s);
    setHistory((h) => [...h.slice(-2000), s]);
  });

  const ts = useMemo(() => history.map((s) => s.ts), [history]);
  const packSeries = useMemo(
    () => [
      { label: "Voltage (V)", stroke: "#4f8ef7", values: history.map((s) => s.total_mv / 1000) },
      { label: "Current (A)", stroke: "#f85149", values: history.map((s) => s.current_ma / 1000) },
    ],
    [history],
  );
  const socSeries = useMemo(
    () => [{ label: "SOC (%)", stroke: "#3fb950", values: history.map((s) => s.overridden_soc) }],
    [history],
  );
  const cellSeries = useMemo(
    () =>
      Array.from({ length: 15 }, (_, i) => ({
        label: `C${i + 1}`,
        stroke: CELL_COLORS[i],
        values: history.map((s) => (s.cells_mv[i] > 0 ? s.cells_mv[i] : null)),
      })),
    [history],
  );

  async function onRename() {
    const name = prompt("Board name", board?.name ?? "");
    if (name) {
      await renameBoard(chipId, name);
      setBoard((b) => (b ? { ...b, name } : b));
    }
  }

  if (!board) return <p className="placeholder">Unknown board {chipId}</p>;

  return (
    <div>
      <h1>
        {board.name}{" "}
        <button onClick={onRename} title="Rename">✏️</button>
      </h1>
      <p className="placeholder">
        chip {board.chip_id} · BMS serial {board.bms_serial} · fw {board.fw_version}
      </p>

      <div className="panel">
        <h3>Live cells</h3>
        {latest ? <CellBars cellsMv={latest.cells_mv} /> : <p>No data yet</p>}
        {latest && (
          <div className="stat-row" style={{ marginTop: "1rem" }}>
            <div className="stat"><b>{(latest.total_mv / 1000).toFixed(2)} V</b><span>pack</span></div>
            <div className="stat"><b>{(latest.current_ma / 1000).toFixed(1)} A</b><span>current</span></div>
            <div className="stat"><b>{latest.overridden_soc}%</b><span>SOC</span></div>
            <div className="stat"><b>{latest.temps_c.join(" / ")} °C</b><span>temps</span></div>
          </div>
        )}
      </div>

      <div className="panel">
        <h3>
          History{" "}
          <select value={range} onChange={(e) => setRange(e.target.value)}>
            {Object.keys(RANGES).map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </h3>
        <TimeSeries timestamps={ts} series={packSeries} />
        <TimeSeries timestamps={ts} series={socSeries} height={140} />
        <h4>Per-cell voltage (mV)</h4>
        <TimeSeries timestamps={ts} series={cellSeries} height={260} />
      </div>

      <div className="panel">
        <h3>Health</h3>
        {health ? (
          <>
            <div className="stat-row">
              <div className="stat">
                <b>{health.capacity_est_mah ? `${(health.capacity_est_mah / 1000).toFixed(1)} Ah` : "—"}</b>
                <span>est. capacity (median of {health.capacity_estimates.length})</span>
              </div>
              <div className="stat">
                <b>{health.cycle_count?.toFixed(1) ?? "—"}</b><span>≈ cycles</span>
              </div>
              <div className="stat">
                <b>{health.regen_ratio ? `${(health.regen_ratio * 100).toFixed(0)}%` : "—"}</b>
                <span>regen ratio</span>
              </div>
              <div className="stat">
                <b>{health.temp_min_c ?? "—"} … {health.temp_max_c ?? "—"} °C</b>
                <span>temp extremes</span>
              </div>
            </div>
            {health.cell_spread_daily.length > 1 && (
              <>
                <h4>Daily max cell spread (mV)</h4>
                <TimeSeries
                  timestamps={health.cell_spread_daily.map((d) => Date.parse(d.day))}
                  series={[{
                    label: "spread (mV)",
                    stroke: "#d29922",
                    values: health.cell_spread_daily.map((d) => d.max_spread_mv),
                  }]}
                  height={140}
                />
              </>
            )}
          </>
        ) : (
          <p className="placeholder">Loading…</p>
        )}
      </div>
    </div>
  );
}
