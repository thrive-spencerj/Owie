import { afterEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { startServer } from "../src/server";
import { makePayload } from "./ingest.test";

let server: ReturnType<typeof startServer>["server"] | undefined;
afterEach(() => server?.stop(true));

describe("server", () => {
  test("POST /api/ingest stores a sample and returns 204", async () => {
    const db = openDb(":memory:");
    ({ server } = startServer({ db, port: 0 }));
    const res = await fetch(`http://localhost:${server.port}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makePayload()),
    });
    expect(res.status).toBe(204);
    const n = db.query("SELECT COUNT(*) AS n FROM samples").get() as any;
    expect(n.n).toBe(1);
  });

  test("POST /api/ingest rejects malformed payloads with 400", async () => {
    const db = openDb(":memory:");
    ({ server } = startServer({ db, port: 0 }));
    const res = await fetch(`http://localhost:${server.port}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chip_id: "c024" }),
    });
    expect(res.status).toBe(400);
    const res2 = await fetch(`http://localhost:${server.port}/api/ingest`, {
      method: "POST",
      body: "not json",
    });
    expect(res2.status).toBe(400);
  });

  test("accepted samples are fanned out to /ws subscribers", async () => {
    const db = openDb(":memory:");
    ({ server } = startServer({ db, port: 0 }));
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    await new Promise((r) => (ws.onopen = r));
    const msg = new Promise<any>((r) => {
      ws.onmessage = (e) => r(JSON.parse(String(e.data)));
    });
    await fetch(`http://localhost:${server.port}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makePayload({ chip_id: "beef" })),
    });
    const got = await msg;
    expect(got.type).toBe("sample");
    expect(got.sample.chip_id).toBe("beef");
    expect(got.sample.ts).toBeGreaterThan(0);
    ws.close();
  });
});
