import { useEffect, useRef, useState } from "react";
import { fetchBoards, type Board, type Sample } from "../api";
import { useLiveSamples } from "../live";

const OFFLINE_MS = 2 * 60_000;

export type BoardStatus = "charging" | "riding" | "offline" | "idle";

export function boardStatus(latest: Sample | null, now: number): BoardStatus {
  if (!latest || now - latest.ts > OFFLINE_MS) return "offline";
  if (latest.charging) return "charging";
  if (latest.current_ma > 500) return "riding";
  return "idle";
}

export default function Fleet() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    fetchBoards().then(setBoards).catch(console.error);
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  const refetching = useRef(false);

  useLiveSamples((s) => {
    setNow(Date.now());
    const known = boards.some((b) => b.chip_id === s.chip_id);
    if (!known) {
      // New board appeared: refetch the full list for its name/metadata,
      // at most one refetch in flight.
      if (!refetching.current) {
        refetching.current = true;
        fetchBoards()
          .then(setBoards)
          .catch(console.error)
          .finally(() => {
            refetching.current = false;
          });
      }
      return;
    }
    setBoards((prev) =>
      prev.map((b) =>
        b.chip_id === s.chip_id ? { ...b, latest: s, last_seen: s.ts } : b,
      ),
    );
  });

  return (
    <div className="fleet">
      {boards.length === 0 && (
        <p className="placeholder">
          No boards yet. Point an owie (or <code>bun run fake</code>) at{" "}
          <code>POST /api/ingest</code>.
        </p>
      )}
      {boards.map((b) => {
        const s = b.latest;
        const status = boardStatus(s, now);
        return (
          <a key={b.chip_id} className={`card status-${status}`} href={`#/board/${b.chip_id}`}>
            <header>
              <h2>{b.name}</h2>
              <span className={`badge ${status}`}>{status}</span>
            </header>
            {s ? (
              <dl>
                <div><dt>SOC</dt><dd>{s.overridden_soc}%</dd></div>
                <div><dt>Voltage</dt><dd>{(s.total_mv / 1000).toFixed(1)} V</dd></div>
                <div><dt>Current</dt><dd>{(s.current_ma / 1000).toFixed(1)} A</dd></div>
                <div><dt>Temp</dt><dd>{Math.max(...s.temps_c)} °C</dd></div>
              </dl>
            ) : (
              <p>No data</p>
            )}
            <footer>last seen {new Date(b.last_seen).toLocaleTimeString()}</footer>
          </a>
        );
      })}
    </div>
  );
}
