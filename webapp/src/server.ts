import type { Database } from "bun:sqlite";
import { handleApi } from "./api";
import { openDb } from "./db";
import { recordSample, validatePayload } from "./ingest";
import { Sessionizer } from "./sessionizer";

const LIVE_TOPIC = "live";

export function startServer(opts: {
  db: Database;
  port: number;
  staticDir?: string;
}) {
  const { db, staticDir } = opts;
  const sessionizer = new Sessionizer(db);
  sessionizer.adoptOpenSessions(Date.now());

  const server = Bun.serve({
    port: opts.port,
    async fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        if (srv.upgrade(req)) return;
        return new Response("websocket upgrade failed", { status: 400 });
      }

      if (url.pathname === "/api/ingest" && req.method === "POST") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "invalid JSON" }, { status: 400 });
        }
        const v = validatePayload(body);
        if (!v.ok) {
          console.warn(`ingest rejected: ${v.error}`);
          return Response.json({ error: v.error }, { status: 400 });
        }
        const sample = recordSample(db, v.payload, Date.now());
        sessionizer.onSample(sample);
        srv.publish(LIVE_TOPIC, JSON.stringify({ type: "sample", sample }));
        return new Response(null, { status: 204 });
      }

      const apiResponse = await handleApi(db, req, url);
      if (apiResponse) return apiResponse;

      if (staticDir && req.method === "GET") {
        const path = url.pathname === "/" ? "/index.html" : url.pathname;
        let file = Bun.file(staticDir + path);
        if (!(await file.exists())) {
          // SPA fallback for client-side routes.
          file = Bun.file(staticDir + "/index.html");
          if (!(await file.exists())) return new Response("not found", { status: 404 });
        }
        return new Response(file);
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.subscribe(LIVE_TOPIC);
      },
      message() {
        // Clients don't send anything.
      },
    },
  });

  return { server, sessionizer };
}

if (import.meta.main) {
  const port = Number(process.env.OWIE_PORT ?? 8020);
  const { server, sessionizer } = startServer({
    db: openDb(),
    port,
    staticDir: new URL("../frontend/dist", import.meta.url).pathname,
  });
  setInterval(() => sessionizer.sweep(Date.now()), 30_000);
  console.log(`owie-telemetry listening on http://localhost:${server.port}`);
}
