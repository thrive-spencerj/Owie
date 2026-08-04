export default function CellBars({ cellsMv }: { cellsMv: number[] }) {
  const live = cellsMv.filter((c) => c > 0);
  if (live.length === 0) return <p className="placeholder">No cell data</p>;
  const min = Math.min(...live);
  const max = Math.max(...live);
  // Scale bars across a tight window so differences are visible.
  const lo = min - 50;
  const hi = max + 50;
  return (
    <div>
      <div className="cells">
        {cellsMv.map((c, i) => {
          const pct = c > 0 ? ((c - lo) / (hi - lo)) * 100 : 0;
          const cls =
            c === min && min !== max ? "cell min" : c === max && min !== max ? "cell max" : "cell";
          return (
            <div key={i} className={cls} style={{ height: `${pct}%` }} title={`Cell ${i + 1}: ${c} mV`}>
              <span>{i + 1}</span>
            </div>
          );
        })}
      </div>
      <p style={{ marginTop: "1.8rem" }}>
        min <b>{min}</b> mV · max <b>{max}</b> mV · spread <b>{max - min}</b> mV
      </p>
    </div>
  );
}
