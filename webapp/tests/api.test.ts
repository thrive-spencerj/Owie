import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleApi } from "../src/api";
import { openDb } from "../src/db";
import { recordSample } from "../src/ingest";
import { makePayload } from "./ingest.test";

let db: Database;
beforeEach(() => {
  db = openDb(":memory:");
});

async function get(path: string, init?: RequestInit): Promise<Response> {
  const url = new URL(`http://x${path}`);
  const res = await handleApi(db, new Request(url, init), url);
  if (!res) throw new Error(`no handler for ${path}`);
  return res;
}

async function getJson<T = any>(path: string): Promise<T> {
  const res = await get(path);
  expect(res.status).toBe(200);
  return res.json() as Promise<T>;
}

describe("GET /api/boards", () => {
  test("lists boards with their latest sample", async () => {
    recordSample(db, makePayload(), 1000);
    recordSample(db, makePayload({ total_mv: 57000 }), 2000);
    recordSample(db, makePayload({ chip_id: "beef" }), 1500);
    const boards = await getJson<any[]>("/api/boards");
    expect(boards).toHaveLength(2);
    const c024 = boards.find((b) => b.chip_id === "c024");
    expect(c024.latest.total_mv).toBe(57000);
    expect(c024.latest.cells_mv).toHaveLength(15);
    expect(typeof c024.latest.charging).toBe("boolean");
  });
});

describe("PATCH /api/boards/:chipId", () => {
  test("renames a board; 404 unknown; 400 empty", async () => {
    recordSample(db, makePayload(), 1000);
    const mk = (path: string, body: unknown) =>
      get(path, { method: "PATCH", body: JSON.stringify(body) });
    expect((await mk("/api/boards/c024", { name: "Floaty" })).status).toBe(200);
    const row = db.query("SELECT name FROM boards WHERE chip_id='c024'").get() as any;
    expect(row.name).toBe("Floaty");
    expect((await mk("/api/boards/c024", { name: "" })).status).toBe(400);
    expect((await mk("/api/boards/nope", { name: "x" })).status).toBe(404);
  });
});

describe("GET samples", () => {
  test("range filter and bucketing", async () => {
    for (let i = 0; i < 10; i++) {
      recordSample(db, makePayload({ total_mv: 58000 - i }), 1000 * (i + 1));
    }
    const raw = await getJson<any[]>("/api/boards/c024/samples?from=2000&to=5000");
    expect(raw).toHaveLength(4);
    expect(raw[0].ts).toBe(2000);
    // ts 1000..10000 with 5000ms buckets spans buckets 0,1,2 (10000/5000 = 2);
    // one row per bucket, each the LAST sample of its bucket.
    const bucketed = await getJson<any[]>(
      "/api/boards/c024/samples?from=0&to=20000&res=5000",
    );
    expect(bucketed.map((r) => r.ts)).toEqual([4000, 9000, 10000]);
  });
});

describe("sessions endpoints", () => {
  function seedSession(): number {
    db.query(
      `INSERT INTO sessions (board_chip_id, kind, started_at, ended_at, start_soc, end_soc,
        start_used_mah, start_regen_mah, last_sample_ts, last_active_ts)
       VALUES ('c024','ride', 1000, 5000, 90, 80, 0, 0, 5000, 5000)`,
    ).run();
    return Number(
      (db.query("SELECT last_insert_rowid() AS id").get() as any).id,
    );
  }

  test("board session list and session detail with samples", async () => {
    recordSample(db, makePayload(), 2000);
    recordSample(db, makePayload(), 9000); // outside session window
    const id = seedSession();
    const list = await getJson<any[]>("/api/boards/c024/sessions");
    expect(list).toHaveLength(1);
    const detail = await getJson<any>(`/api/sessions/${id}`);
    expect(detail.kind).toBe("ride");
    expect(detail.samples).toHaveLength(1);
    expect(detail.samples[0].ts).toBe(2000);
    expect((await get("/api/sessions/99999")).status).toBe(404);
  });
});

describe("unmatched routes", () => {
  test("returns undefined so the server can fall through to static", async () => {
    for (const path of ["/api/nope", "/index.html"]) {
      const url = new URL(`http://x${path}`);
      expect(await handleApi(db, new Request(url), url)).toBeUndefined();
    }
  });
});
