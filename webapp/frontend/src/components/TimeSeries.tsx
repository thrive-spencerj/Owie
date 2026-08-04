import { useEffect, useRef } from "react";
import uPlot from "uplot";

export interface SeriesDef {
  label: string;
  stroke: string;
  values: (number | null)[];
}

export default function TimeSeries({
  timestamps, // epoch ms
  series,
  height = 220,
}: {
  timestamps: number[];
  series: SeriesDef[];
  height?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  // Chart structure only depends on the series identities, not their data.
  const seriesKey = series.map((s) => `${s.label}:${s.stroke}`).join("|");
  const seriesRef = useRef(series);
  seriesRef.current = series;

  // Create/destroy the chart only when its structure changes.
  useEffect(() => {
    if (!el.current) return;
    const defs = seriesRef.current;
    const opts: uPlot.Options = {
      width: el.current.clientWidth,
      height,
      series: [
        {},
        ...defs.map((s) => ({ label: s.label, stroke: s.stroke, width: 1.5 })),
      ],
      legend: { show: defs.length > 1 },
    };
    plot.current = new uPlot(opts, [[], ...defs.map(() => [])], el.current);
    const onResize = () => {
      if (el.current) plot.current?.setSize({ width: el.current.clientWidth, height });
    };
    addEventListener("resize", onResize);
    return () => {
      removeEventListener("resize", onResize);
      plot.current?.destroy();
      plot.current = null;
    };
  }, [seriesKey, height]);

  // Push data into the existing chart without rebuilding it.
  useEffect(() => {
    if (!plot.current) return;
    const data: uPlot.AlignedData = [
      timestamps.map((t) => t / 1000),
      ...series.map((s) => s.values),
    ];
    plot.current.setData(data);
  }, [timestamps, series]);

  return <div ref={el} />;
}
