import { useEffect, useRef } from "react";
import type { Sample } from "./api";

/** Reconnecting WebSocket that invokes the callback for every live sample. */
export function useLiveSamples(onSample: (s: Sample) => void): void {
  const cb = useRef(onSample);
  cb.current = onSample;
  useEffect(() => {
    let ws: WebSocket | undefined;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.type === "sample") cb.current(msg.sample);
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);
}
