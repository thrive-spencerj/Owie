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

  useEffect(() => {
    if (!el.current) return;
    const data: uPlot.AlignedData = [
      timestamps.map((t) => t / 1000),
      ...series.map((s) => s.values),
    ];
    const opts: uPlot.Options = {
      width: el.current.clientWidth,
      height,
      series: [
        {},
        ...series.map((s) => ({ label: s.label, stroke: s.stroke, width: 1.5 })),
      ],
      legend: { show: series.length > 1 },
    };
    plot.current?.destroy();
    plot.current = new uPlot(opts, data, el.current);
    const onResize = () => {
      if (el.current) plot.current?.setSize({ width: el.current.clientWidth, height });
    };
    addEventListener("resize", onResize);
    return () => {
      removeEventListener("resize", onResize);
      plot.current?.destroy();
      plot.current = null;
    };
  }, [timestamps, series, height]);

  return <div ref={el} />;
}
