# Owie Battery Telemetry Webapp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A LAN-only Bun webapp that ingests telemetry pushed by Owie boards, stores it in SQLite, derives ride/charge sessions and health trends, and shows a live React dashboard.

**Architecture:** One `Bun.serve` process handles JSON ingest (`POST /api/ingest`), read APIs, a WebSocket that fans out every accepted sample, and static serving of the built Vite frontend. Storage is a single `bun:sqlite` database in WAL mode. A synchronous sessionizer runs on each ingested sample. A `fake-owie.ts` simulator enables development with zero hardware.

**Tech Stack:** Bun ≥ 1.1 (runtime, test runner, SQLite), TypeScript, Vite + React 18, uPlot (bundled, no CDN).

**Spec:** `docs/superpowers/specs/2026-08-03-owie-battery-telemetry-webapp-design.md` — the ingest payload contract, sessionizer rules, and API shapes there are authoritative.

## Global Constraints

- Everything lives under `webapp/` in this repo. Backend imports use relative paths only.
- Server port: `8020` (env `OWIE_PORT` overrides). DB file: `owie.db` in `webapp/` (env `OWIE_DB` overrides; tests use `:memory:`).
- Plain HTTP only. No auth. No CDN/external network dependencies in the frontend bundle.
- Sessionizer constants (from spec): ride threshold `500` mA discharge, `3` consecutive samples to open a ride, `5`-minute idle timeout, charging takes precedence over riding.
- Timestamps are epoch **milliseconds**, assigned server-side on ingest.
- All commands below run from `webapp/` unless stated otherwise.
- TDD: every backend behavior gets its failing test first. Run tests with `bun test <file>`.

---

### Task 1: Scaffold + database schema

**Files:**
- Create: `webapp/package.json`
- Create: `webapp/tsconfig.json`
- Create: `webapp/src/types.ts`
- Create: `webapp/src/db.ts`
- Test: `webapp/tests/db.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `openDb(path?: string): Database` from `src/db.ts` — opens/creates the SQLite DB, enables WAL, creates tables `boards`, `samples`, `sessions` idempotently. `src/types.ts` exports `IngestPayload`, `Sample`, `BoardRow`, `SessionRow` used by every later task.

- [ ] **Step 1: Create package.json and tsconfig.json**

`webapp/package.json`:

```json
{
  "name": "owie-telemetry",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "bun run src/server.ts",
    "dev": "bun --watch src/server.ts",
    "fake": "bun run scripts/fake-owie.ts",
    "test": "bun test"
  }
}
```

`webapp/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "tests", "scripts"]
}
```

Run: `cd webapp && bun add -d bun-types typescript`
Expected: `bun.lock` and `node_modules/` created.

- [ ] **Step 2: Create shared types**

`webapp/src/types.ts`:

```ts
export interface IngestPayload {
  chip_id: string;
  bms_serial: number;
  fw_version: string;
  uptime_s: number;
  total_mv: number;
  current_ma: number; // signed; positive = discharge
  bms_soc: number;
  overridden_soc: number;
  voltage_soc: number;
  cells_mv: number[]; // exactly 15
  temps_c: number[]; // exactly 5
  charging: boolean;
  status_byte: number;
  used_mah: number; // cumulative, monotonic (NVS-backed fuel gauge)
  regen_mah: number; // cumulative, monotonic
}

export interface Sample extends IngestPayload {
  id: number;
  ts: number; // epoch ms, server-assigned
}

export interface BoardRow {
  chip_id: string;
  name: string;
  bms_serial: number;
  fw_version: string;
  first_seen: number;
  last_seen: number;
}

export type SessionKind = "ride" | "charge";

export interface SessionRow {
  id: number;
  board_chip_id: string;
  kind: SessionKind;
  started_at: number;
  ended_at: number | null;
  start_soc: number;
  end_soc: number;
  mah_delta: number;
  wh_delta: number;
  min_cell_mv: number | null;
  max_cell_mv: number | null;
  max_cell_spread_mv: number | null;
  min_temp_c: number | null;
  max_temp_c: number | null;
  sample_count: number;
  start_used_mah: number;
  start_regen_mah: number;
  last_sample_ts: number;
  last_active_ts: number;
}
```

- [ ] **Step 3: Write the failing test**

`webapp/tests/db.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";

describe("openDb", () => {
  test("creates the three tables and is idempotent", () => {
    const db = openDb(":memory:");
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toContain("boards");
    expect(tables).toContain("samples");
    expect(tables).toContain("sessions");
    // Re-running schema creation must not throw.
    expect(() => openDb(":memory:")).not.toThrow();
  });

  test("samples has an index on board and ts", () => {
    const db = openDb(":memory:");
    const idx = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index'",
      )
      .all()
      .map((r) => r.name);
    expect(idx).toContain("idx_samples_board_ts");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test tests/db.test.ts`
Expected: FAIL — `Cannot find module '../src/db'`.

- [ ] **Step 5: Implement db.ts**

`webapp/src/db.ts`:

```ts
import { Database } from "bun:sqlite";

export function openDb(
  path: string = process.env.OWIE_DB ?? "owie.db",
): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS boards (
      chip_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      bms_serial INTEGER NOT NULL DEFAULT 0,
      fw_version TEXT NOT NULL DEFAULT '',
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_chip_id TEXT NOT NULL REFERENCES boards(chip_id),
      ts INTEGER NOT NULL,
      total_mv INTEGER NOT NULL,
      current_ma INTEGER NOT NULL,
      bms_soc INTEGER NOT NULL,
      overridden_soc INTEGER NOT NULL,
      voltage_soc INTEGER NOT NULL,
      cells_mv TEXT NOT NULL,
      temps_c TEXT NOT NULL,
      charging INTEGER NOT NULL,
      status_byte INTEGER NOT NULL,
      used_mah INTEGER NOT NULL,
      regen_mah INTEGER NOT NULL,
      uptime_s INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_samples_board_ts
      ON samples(board_chip_id, ts);
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_chip_id TEXT NOT NULL REFERENCES boards(chip_id),
      kind TEXT NOT NULL CHECK (kind IN ('ride','charge')),
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      start_soc INTEGER NOT NULL,
      end_soc INTEGER NOT NULL,
      mah_delta REAL NOT NULL DEFAULT 0,
      wh_delta REAL NOT NULL DEFAULT 0,
      min_cell_mv INTEGER,
      max_cell_mv INTEGER,
      max_cell_spread_mv INTEGER,
      min_temp_c INTEGER,
      max_temp_c INTEGER,
      sample_count INTEGER NOT NULL DEFAULT 0,
      start_used_mah INTEGER NOT NULL,
      start_regen_mah INTEGER NOT NULL,
      last_sample_ts INTEGER NOT NULL,
      last_active_ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_board
      ON sessions(board_chip_id, started_at);
  `);
  return db;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/db.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add webapp/package.json webapp/tsconfig.json webapp/bun.lock webapp/src/types.ts webapp/src/db.ts webapp/tests/db.test.ts
git commit -m "webapp: scaffold Bun project with SQLite schema"
```

---

### Task 2: Ingest validation and sample recording

**Files:**
- Create: `webapp/src/ingest.ts`
- Test: `webapp/tests/ingest.test.ts`

**Interfaces:**
- Consumes: `openDb` (Task 1), types from `src/types.ts`.
- Produces:
  - `validatePayload(body: unknown): { ok: true; payload: IngestPayload } | { ok: false; error: string }`
  - `recordSample(db: Database, payload: IngestPayload, ts: number): Sample` — upserts the board row and inserts the sample, returning it with `id` and `ts` filled in. Task 4's ingest route calls exactly these two functions.

- [ ] **Step 1: Write the failing tests**

`webapp/tests/ingest.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { recordSample, validatePayload } from "../src/ingest";
import type { IngestPayload } from "../src/types";

export function makePayload(
  overrides: Partial<IngestPayload> = {},
): IngestPayload {
  return {
    chip_id: "c024",
    bms_serial: 12345,
    fw_version: "2.0.0-dev",
    uptime_s: 60,
    total_mv: 58000,
    current_ma: 0,
    bms_soc: 80,
    overridden_soc: 82,
    voltage_soc: 81,
    cells_mv: Array(15).fill(3866),
    temps_c: [20, 21, 20, 19, 20],
    charging: false,
    status_byte: 0,
    used_mah: 1000,
    regen_mah: 100,
    ...overrides,
  };
}

describe("validatePayload", () => {
  test("accepts a well-formed payload", () => {
    const r = validatePayload(makePayload());
    expect(r.ok).toBe(true);
  });

  test("rejects missing fields, wrong array lengths, bad types", () => {
    const missing: Record<string, unknown> = { ...makePayload() };
    delete missing.total_mv;
    expect(validatePayload(missing).ok).toBe(false);
    expect(validatePayload(makePayload({ cells_mv: Array(14).fill(3866) })).ok).toBe(false);
    expect(validatePayload(makePayload({ temps_c: [1, 2, 3] })).ok).toBe(false);
    expect(validatePayload({ ...makePayload(), current_ma: "5" }).ok).toBe(false);
    expect(validatePayload(null).ok).toBe(false);
    expect(validatePayload("hi").ok).toBe(false);
  });
});

describe("recordSample", () => {
  test("auto-creates the board with default name and inserts the sample", () => {
    const db = openDb(":memory:");
    const s = recordSample(db, makePayload(), 1000);
    expect(s.id).toBeGreaterThan(0);
    expect(s.ts).toBe(1000);
    const board = db
      .query("SELECT * FROM boards WHERE chip_id = 'c024'")
      .get() as any;
    expect(board.name).toBe("Owie-C024");
    expect(board.first_seen).toBe(1000);
    const row = db.query("SELECT * FROM samples").get() as any;
    expect(JSON.parse(row.cells_mv)).toHaveLength(15);
  });

  test("second sample updates last_seen/fw/serial but not first_seen or name", () => {
    const db = openDb(":memory:");
    recordSample(db, makePayload(), 1000);
    db.exec("UPDATE boards SET name = 'Floaty' WHERE chip_id = 'c024'");
    recordSample(db, makePayload({ fw_version: "2.0.1", bms_serial: 999 }), 2000);
    const board = db
      .query("SELECT * FROM boards WHERE chip_id = 'c024'")
      .get() as any;
    expect(board.first_seen).toBe(1000);
    expect(board.last_seen).toBe(2000);
    expect(board.fw_version).toBe("2.0.1");
    expect(board.bms_serial).toBe(999);
    expect(board.name).toBe("Floaty");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/ingest.test.ts`
Expected: FAIL — `Cannot find module '../src/ingest'`.

- [ ] **Step 3: Implement ingest.ts**

`webapp/src/ingest.ts`:

```ts
import type { Database } from "bun:sqlite";
import type { IngestPayload, Sample } from "./types";

const NUMBER_FIELDS = [
  "bms_serial",
  "uptime_s",
  "total_mv",
  "current_ma",
  "bms_soc",
  "overridden_soc",
  "voltage_soc",
  "status_byte",
  "used_mah",
  "regen_mah",
] as const;

export function validatePayload(
  body: unknown,
): { ok: true; payload: IngestPayload } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "payload must be a JSON object" };
  }
  const o = body as Record<string, unknown>;
  if (typeof o.chip_id !== "string" || o.chip_id.length === 0) {
    return { ok: false, error: "chip_id must be a non-empty string" };
  }
  if (typeof o.fw_version !== "string") {
    return { ok: false, error: "fw_version must be a string" };
  }
  if (typeof o.charging !== "boolean") {
    return { ok: false, error: "charging must be a boolean" };
  }
  for (const f of NUMBER_FIELDS) {
    if (typeof o[f] !== "number" || !Number.isFinite(o[f] as number)) {
      return { ok: false, error: `${f} must be a finite number` };
    }
  }
  const isNumArray = (v: unknown, len: number): v is number[] =>
    Array.isArray(v) &&
    v.length === len &&
    v.every((x) => typeof x === "number" && Number.isFinite(x));
  if (!isNumArray(o.cells_mv, 15)) {
    return { ok: false, error: "cells_mv must be an array of 15 numbers" };
  }
  if (!isNumArray(o.temps_c, 5)) {
    return { ok: false, error: "temps_c must be an array of 5 numbers" };
  }
  return { ok: true, payload: o as unknown as IngestPayload };
}

export function recordSample(
  db: Database,
  p: IngestPayload,
  ts: number,
): Sample {
  db.query(
    `INSERT INTO boards (chip_id, name, bms_serial, fw_version, first_seen, last_seen)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT(chip_id) DO UPDATE SET
       bms_serial = excluded.bms_serial,
       fw_version = excluded.fw_version,
       last_seen = excluded.last_seen`,
  ).run(
    p.chip_id,
    `Owie-${p.chip_id.toUpperCase()}`,
    p.bms_serial,
    p.fw_version,
    ts,
  );
  const res = db
    .query(
      `INSERT INTO samples (
         board_chip_id, ts, total_mv, current_ma, bms_soc, overridden_soc,
         voltage_soc, cells_mv, temps_c, charging, status_byte,
         used_mah, regen_mah, uptime_s
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      p.chip_id,
      ts,
      p.total_mv,
      p.current_ma,
      p.bms_soc,
      p.overridden_soc,
      p.voltage_soc,
      JSON.stringify(p.cells_mv),
      JSON.stringify(p.temps_c),
      p.charging ? 1 : 0,
      p.status_byte,
      p.used_mah,
      p.regen_mah,
      p.uptime_s,
    ) as { id: number };
  return { ...p, id: res.id, ts };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/ingest.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add webapp/src/ingest.ts webapp/tests/ingest.test.ts
git commit -m "webapp: ingest payload validation and sample recording"
```

---

### Task 3: Sessionizer

**Files:**
- Create: `webapp/src/sessionizer.ts`
- Test: `webapp/tests/sessionizer.test.ts`

**Interfaces:**
- Consumes: `openDb`, `recordSample`, `makePayload` (exported from `tests/ingest.test.ts`), `Sample`/`SessionRow` types.
- Produces: `class Sessionizer` with:
  - `constructor(db: Database)`
  - `onSample(s: Sample): void` — must be called after `recordSample`, once per sample.
  - `sweep(now: number): void` — closes idle-timed-out sessions; Task 4 calls it on an interval.
  - `adoptOpenSessions(now: number): void` — startup reconciliation.
  - Exported constants: `RIDE_THRESHOLD_MA = 500`, `RIDE_CONSECUTIVE = 3`, `IDLE_TIMEOUT_MS = 5 * 60_000`, `MAX_INTEGRATION_GAP_MS = 60_000`.

Rules implemented (from spec §3): charge opens on `charging`, closes on `!charging` or idle timeout. Ride opens when `RIDE_CONSECUTIVE` consecutive samples have `current_ma > RIDE_THRESHOLD_MA` (with `started_at` = first of those samples); a charge start closes an open ride; ride closes when 5 minutes pass with no over-threshold sample (`ended_at` = last over-threshold sample's ts). Stats update incrementally; `wh_delta` integrates `V×I` over inter-sample gaps capped at `MAX_INTEGRATION_GAP_MS`; cell stats ignore zero cells (BMS not yet reporting).

- [ ] **Step 1: Write the failing tests**

`webapp/tests/sessionizer.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { recordSample } from "../src/ingest";
import {
  IDLE_TIMEOUT_MS,
  RIDE_THRESHOLD_MA,
  Sessionizer,
} from "../src/sessionizer";
import type { IngestPayload, SessionRow } from "../src/types";
import { makePayload } from "./ingest.test";

let db: Database;
let szr: Sessionizer;

function feed(ts: number, overrides: Partial<IngestPayload> = {}) {
  const s = recordSample(db, makePayload(overrides), ts);
  szr.onSample(s);
  return s;
}

function sessions(): SessionRow[] {
  return db
    .query<SessionRow, []>("SELECT * FROM sessions ORDER BY id")
    .all();
}

beforeEach(() => {
  db = openDb(":memory:");
  szr = new Sessionizer(db);
});

describe("charge sessions", () => {
  test("opens on charging=true and closes on charging=false", () => {
    feed(1000, { charging: true, current_ma: -2000, overridden_soc: 50 });
    let all = sessions();
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe("charge");
    expect(all[0].started_at).toBe(1000);
    expect(all[0].ended_at).toBeNull();
    expect(all[0].start_soc).toBe(50);

    feed(3000, { charging: true, current_ma: -2000, overridden_soc: 51 });
    feed(5000, { charging: false, overridden_soc: 51 });
    all = sessions();
    expect(all).toHaveLength(1);
    expect(all[0].ended_at).toBe(5000);
    expect(all[0].end_soc).toBe(51);
    expect(all[0].sample_count).toBe(2);
  });

  test("closes by idle timeout via sweep at last sample ts", () => {
    feed(1000, { charging: true });
    szr.sweep(1000 + IDLE_TIMEOUT_MS + 1);
    const s = sessions()[0];
    expect(s.ended_at).toBe(1000);
  });
});

describe("ride sessions", () => {
  test("opens only after 3 consecutive over-threshold samples, started_at = first", () => {
    feed(1000, { current_ma: 3000 });
    feed(3000, { current_ma: 3000 });
    expect(sessions()).toHaveLength(0);
    feed(5000, { current_ma: 3000 });
    const s = sessions();
    expect(s).toHaveLength(1);
    expect(s[0].kind).toBe("ride");
    expect(s[0].started_at).toBe(1000);
  });

  test("a sub-threshold sample resets the pending streak", () => {
    feed(1000, { current_ma: 3000 });
    feed(3000, { current_ma: 3000 });
    feed(5000, { current_ma: 100 });
    feed(7000, { current_ma: 3000 });
    feed(9000, { current_ma: 3000 });
    expect(sessions()).toHaveLength(0);
  });

  test("closes after 5 idle minutes with ended_at = last over-threshold ts", () => {
    feed(1000, { current_ma: 3000 });
    feed(3000, { current_ma: 3000 });
    feed(5000, { current_ma: 3000 });
    // Board sits still but keeps posting (idle cadence).
    feed(7000, { current_ma: 0 });
    feed(7000 + IDLE_TIMEOUT_MS + 1, { current_ma: 0 });
    const s = sessions()[0];
    expect(s.ended_at).toBe(5000);
  });

  test("charge start closes an open ride", () => {
    feed(1000, { current_ma: 3000 });
    feed(3000, { current_ma: 3000 });
    feed(5000, { current_ma: 3000 });
    feed(7000, { charging: true, current_ma: -2000 });
    const all = sessions();
    expect(all).toHaveLength(2);
    expect(all[0].kind).toBe("ride");
    expect(all[0].ended_at).toBe(7000);
    expect(all[1].kind).toBe("charge");
    expect(all[1].ended_at).toBeNull();
  });
});

describe("stats", () => {
  test("mah_delta, wh_delta, cell and temp extremes accumulate", () => {
    // Ride: 10A at ~58V for 10s (after session opens on 3rd sample).
    feed(1000, { current_ma: 10000, used_mah: 1000, regen_mah: 100 });
    feed(2000, { current_ma: 10000, used_mah: 1003, regen_mah: 100 });
    feed(3000, {
      current_ma: 10000,
      used_mah: 1006,
      regen_mah: 100,
      cells_mv: [3700, ...Array(13).fill(3866), 3900],
      temps_c: [18, 21, 20, 19, 25],
    });
    feed(13000, { current_ma: 10000, used_mah: 1034, regen_mah: 101 });
    const s = sessions()[0];
    // start counters come from the FIRST sample of the streak (used 1000/regen 100)
    expect(s.mah_delta).toBe(1034 - 1000 - (101 - 100));
    // wh integration from started_at (1000): 58V * 10A * 2s / 3600 = 0.322 Wh
    // (session-open update) + 58V * 10A * 10s / 3600 = 1.611 Wh => ~1.933 Wh
    expect(s.wh_delta).toBeGreaterThan(1.9);
    expect(s.wh_delta).toBeLessThan(2.0);
    expect(s.min_cell_mv).toBe(3700);
    expect(s.max_cell_mv).toBe(3900);
    expect(s.max_cell_spread_mv).toBe(200);
    expect(s.min_temp_c).toBe(18);
    expect(s.max_temp_c).toBe(25);
  });

  test("zero cells are ignored in cell stats", () => {
    feed(1000, { charging: true, cells_mv: [0, ...Array(14).fill(3866)] });
    const s = sessions()[0];
    expect(s.min_cell_mv).toBe(3866);
    expect(s.max_cell_spread_mv).toBe(0);
  });

  test("integration gap is capped at 60s", () => {
    feed(1000, { current_ma: 10000 });
    feed(2000, { current_ma: 10000 });
    feed(3000, { current_ma: 10000 });
    const before = sessions()[0].wh_delta;
    feed(3000 + 4 * 60_000, { current_ma: 10000 }); // 4-min gap, still < timeout
    const after = sessions()[0].wh_delta;
    // 58V * 10A * 60s(cap) / 3600 = 9.67 Wh max added
    expect(after - before).toBeLessThan(10);
  });
});

describe("startup adoption", () => {
  test("adoptOpenSessions closes stale sessions and keeps fresh ones", () => {
    feed(1000, { charging: true });
    const szr2 = new Sessionizer(db);
    szr2.adoptOpenSessions(1000 + IDLE_TIMEOUT_MS + 1);
    expect(sessions()[0].ended_at).toBe(1000);

    feed(10_000_000, { chip_id: "beef", charging: true });
    const szr3 = new Sessionizer(db);
    szr3.adoptOpenSessions(10_000_000 + 1000);
    const open = sessions().find((s) => s.board_chip_id === "beef")!;
    expect(open.ended_at).toBeNull();
    // and the adopted session keeps updating
    const s = recordSample(
      db,
      makePayload({ chip_id: "beef", charging: true }),
      10_002_000,
    );
    szr3.onSample(s);
    expect(
      sessions().find((x) => x.board_chip_id === "beef")!.sample_count,
    ).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/sessionizer.test.ts`
Expected: FAIL — `Cannot find module '../src/sessionizer'`.

- [ ] **Step 3: Implement sessionizer.ts**

`webapp/src/sessionizer.ts`:

```ts
import type { Database } from "bun:sqlite";
import type { Sample, SessionRow } from "./types";

export const RIDE_THRESHOLD_MA = 500;
export const RIDE_CONSECUTIVE = 3;
export const IDLE_TIMEOUT_MS = 5 * 60_000;
export const MAX_INTEGRATION_GAP_MS = 60_000;

interface PendingRide {
  count: number;
  first: Sample;
}

export class Sessionizer {
  private pendingRide = new Map<string, PendingRide>();

  constructor(private db: Database) {}

  onSample(s: Sample): void {
    const open = this.getOpenSession(s.chip_id);
    if (s.charging) {
      this.pendingRide.delete(s.chip_id);
      if (open?.kind === "ride") this.close(open, s.ts);
      const charge =
        open?.kind === "charge" ? open : this.openSession("charge", s, s);
      this.update(charge, s, /*active=*/ true);
      return;
    }
    if (open?.kind === "charge") {
      this.close(open, s.ts);
    } else if (open?.kind === "ride") {
      const active = s.current_ma > RIDE_THRESHOLD_MA;
      if (!active && s.ts - open.last_active_ts > IDLE_TIMEOUT_MS) {
        this.close(open, open.last_active_ts);
      } else {
        this.update(open, s, active);
      }
      return;
    }
    // No open session: track the pending ride streak.
    if (s.current_ma > RIDE_THRESHOLD_MA) {
      const p = this.pendingRide.get(s.chip_id);
      const next: PendingRide = p
        ? { count: p.count + 1, first: p.first }
        : { count: 1, first: s };
      if (next.count >= RIDE_CONSECUTIVE) {
        this.pendingRide.delete(s.chip_id);
        const ride = this.openSession("ride", next.first, s);
        this.update(ride, s, /*active=*/ true);
      } else {
        this.pendingRide.set(s.chip_id, next);
      }
    } else {
      this.pendingRide.delete(s.chip_id);
    }
  }

  /** Close any open session that has heard nothing for the idle timeout. */
  sweep(now: number): void {
    const open = this.db
      .query<SessionRow, []>("SELECT * FROM sessions WHERE ended_at IS NULL")
      .all();
    for (const sess of open) {
      if (now - sess.last_sample_ts > IDLE_TIMEOUT_MS) {
        this.close(
          sess,
          sess.kind === "ride" ? sess.last_active_ts : sess.last_sample_ts,
        );
      }
    }
  }

  /** Startup reconciliation: same rule as sweep. */
  adoptOpenSessions(now: number): void {
    this.sweep(now);
  }

  private getOpenSession(chipId: string): SessionRow | null {
    return (
      this.db
        .query<SessionRow, [string]>(
          "SELECT * FROM sessions WHERE board_chip_id = ? AND ended_at IS NULL",
        )
        .get(chipId) ?? null
    );
  }

  /** `first` provides started_at and start counters; `current` is the sample being processed. */
  private openSession(
    kind: "ride" | "charge",
    first: Sample,
    current: Sample,
  ): SessionRow {
    const row = this.db
      .query<SessionRow, [string, string, number, number, number, number, number, number]>(
        `INSERT INTO sessions (
           board_chip_id, kind, started_at, start_soc, end_soc,
           start_used_mah, start_regen_mah, last_sample_ts, last_active_ts
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      // last_sample_ts starts at started_at so the first update() integrates
      // from the true beginning of the session.
      .get(
        first.chip_id,
        kind,
        first.ts,
        first.overridden_soc,
        first.overridden_soc,
        first.used_mah,
        first.regen_mah,
        first.ts,
        first.ts,
      ) as unknown as SessionRow;
    void current;
    return row;
  }

  private update(sess: SessionRow, s: Sample, active: boolean): void {
    const dtMs = Math.min(
      Math.max(s.ts - sess.last_sample_ts, 0),
      MAX_INTEGRATION_GAP_MS,
    );
    const whAdd =
      ((s.total_mv / 1000) * (Math.abs(s.current_ma) / 1000) * (dtMs / 1000)) /
      3600;
    const usedDelta = s.used_mah - sess.start_used_mah;
    const regenDelta = s.regen_mah - sess.start_regen_mah;
    const mahDelta =
      sess.kind === "ride" ? usedDelta - regenDelta : regenDelta - usedDelta;

    const liveCells = s.cells_mv.filter((c) => c > 0);
    const minCell = liveCells.length ? Math.min(...liveCells) : null;
    const maxCell = liveCells.length ? Math.max(...liveCells) : null;
    const spread =
      minCell !== null && maxCell !== null ? maxCell - minCell : null;
    const minTemp = Math.min(...s.temps_c);
    const maxTemp = Math.max(...s.temps_c);

    this.db
      .query(
        `UPDATE sessions SET
           end_soc = ?,
           mah_delta = ?,
           wh_delta = wh_delta + ?,
           min_cell_mv = MIN(COALESCE(min_cell_mv, 1000000), COALESCE(?, 1000000)),
           max_cell_mv = MAX(COALESCE(max_cell_mv, -1), COALESCE(?, -1)),
           max_cell_spread_mv = MAX(COALESCE(max_cell_spread_mv, -1), COALESCE(?, -1)),
           min_temp_c = MIN(COALESCE(min_temp_c, 1000), ?),
           max_temp_c = MAX(COALESCE(max_temp_c, -1000), ?),
           sample_count = sample_count + 1,
           last_sample_ts = ?,
           last_active_ts = ?
         WHERE id = ?`,
      )
      .run(
        s.overridden_soc,
        mahDelta,
        whAdd,
        minCell,
        maxCell,
        spread,
        minTemp,
        maxTemp,
        s.ts,
        active ? s.ts : sess.last_active_ts,
        sess.id,
      );
  }

  private close(sess: SessionRow, endedAt: number): void {
    this.db
      .query("UPDATE sessions SET ended_at = ? WHERE id = ?")
      .run(endedAt, sess.id);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/sessionizer.test.ts`
Expected: PASS (9 tests). If the wh_delta bounds test fails, check the dt integration — the first over-threshold samples before the session opens must NOT contribute (integration starts at `started_at`).

- [ ] **Step 5: Run the whole suite and commit**

Run: `bun test`
Expected: all tests pass.

```bash
git add webapp/src/sessionizer.ts webapp/tests/sessionizer.test.ts
git commit -m "webapp: ride/charge sessionizer with incremental stats"
```

---

### Task 4: HTTP server — ingest route, WebSocket fan-out

**Files:**
- Create: `webapp/src/server.ts`
- Test: `webapp/tests/server.test.ts`

**Interfaces:**
- Consumes: `openDb`, `validatePayload`, `recordSample`, `Sessionizer` (+ `IDLE_TIMEOUT_MS`), `handleApi` (Task 5 — until Task 5 lands, `src/api.ts` doesn't exist; this task creates a stub for it, Task 5 replaces the stub).
- Produces:
  - `startServer(opts: { db: Database; port: number; staticDir?: string })` → returns `{ server, sessionizer }` where `server` is the Bun server (has `.port`, `.stop()`).
  - WebSocket protocol on `/ws`: server → client JSON messages `{ type: "sample", sample: Sample }`. No client → server messages.
  - `src/server.ts` run directly (`import.meta.main`) starts on `OWIE_PORT ?? 8020` with `webapp/frontend/dist` as staticDir, runs `adoptOpenSessions` at boot and schedules `sweep` every 30 s (the interval lives in the `import.meta.main` block so tests don't leak timers).

- [ ] **Step 1: Create the api stub (replaced in Task 5)**

`webapp/src/api.ts`:

```ts
import type { Database } from "bun:sqlite";

export function handleApi(
  db: Database,
  req: Request,
  url: URL,
): Response | Promise<Response> | undefined {
  void db;
  void req;
  void url;
  return undefined; // Task 5 implements the read API.
}
```

- [ ] **Step 2: Write the failing tests**

`webapp/tests/server.test.ts`:

```ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/server.test.ts`
Expected: FAIL — `Cannot find module '../src/server'`.

- [ ] **Step 4: Implement server.ts**

`webapp/src/server.ts`:

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add webapp/src/server.ts webapp/src/api.ts webapp/tests/server.test.ts
git commit -m "webapp: Bun server with ingest route and live WebSocket fan-out"
```

---

### Task 5: Read API — boards, rename, samples, sessions

**Files:**
- Modify: `webapp/src/api.ts` (replace the Task 4 stub entirely)
- Test: `webapp/tests/api.test.ts`

**Interfaces:**
- Consumes: schema from Task 1, `recordSample` for test seeding.
- Produces: `handleApi(db, req, url): Response | undefined` (same signature the server already calls) serving:
  - `GET /api/boards` → `Array<BoardRow & { latest: Sample | null }>`
  - `PATCH /api/boards/:chipId` body `{ name: string }` → 200 `{ ok: true }`, 404 if unknown board, 400 if name empty/missing.
  - `GET /api/boards/:chipId/samples?from=<ms>&to=<ms>&res=<ms>` → `Sample[]` ascending by ts. `res` omitted/0 = raw; otherwise one representative sample (last in bucket) per `res`-ms bucket.
  - `GET /api/boards/:chipId/sessions` → `SessionRow[]` descending by `started_at`.
  - `GET /api/sessions/:id` → `SessionRow & { samples: Sample[] }`, 404 if unknown.
- Note: `parseSampleRow` defined here converts DB rows (JSON strings, 0/1 charging) back into `Sample` objects — reused by the health endpoint in Task 6.

- [ ] **Step 1: Write the failing tests**

`webapp/tests/api.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/api.test.ts`
Expected: FAIL — boards list returns undefined (stub), assertions fail.

- [ ] **Step 3: Implement api.ts (full replacement of the stub)**

`webapp/src/api.ts`:

```ts
import type { Database } from "bun:sqlite";
import type { Sample } from "./types";

export function parseSampleRow(row: any): Sample {
  return {
    id: row.id,
    ts: row.ts,
    chip_id: row.board_chip_id,
    bms_serial: 0, // per-board, lives on boards row
    fw_version: "",
    uptime_s: row.uptime_s,
    total_mv: row.total_mv,
    current_ma: row.current_ma,
    bms_soc: row.bms_soc,
    overridden_soc: row.overridden_soc,
    voltage_soc: row.voltage_soc,
    cells_mv: JSON.parse(row.cells_mv),
    temps_c: JSON.parse(row.temps_c),
    charging: !!row.charging,
    status_byte: row.status_byte,
    used_mah: row.used_mah,
    regen_mah: row.regen_mah,
  };
}

export function handleApi(
  db: Database,
  req: Request,
  url: URL,
): Response | Promise<Response> | undefined {
  const p = url.pathname;

  if (p === "/api/boards" && req.method === "GET") {
    const boards = db.query("SELECT * FROM boards ORDER BY name").all() as any[];
    const latestQ = db.query(
      "SELECT * FROM samples WHERE board_chip_id = ? ORDER BY ts DESC LIMIT 1",
    );
    return Response.json(
      boards.map((b) => {
        const row = latestQ.get(b.chip_id);
        return { ...b, latest: row ? parseSampleRow(row) : null };
      }),
    );
  }

  let m = p.match(/^\/api\/boards\/([^/]+)$/);
  if (m && req.method === "PATCH") {
    return patchBoard(db, req, m[1]);
  }

  m = p.match(/^\/api\/boards\/([^/]+)\/samples$/);
  if (m && req.method === "GET") {
    const from = Number(url.searchParams.get("from") ?? 0);
    const to = Number(url.searchParams.get("to") ?? Date.now());
    const res = Number(url.searchParams.get("res") ?? 0);
    let rows: any[];
    if (res > 0) {
      rows = db
        .query(
          `SELECT * FROM samples
           WHERE id IN (
             SELECT MAX(id) FROM samples
             WHERE board_chip_id = ?1 AND ts >= ?2 AND ts <= ?3
             GROUP BY ts / ?4
           )
           ORDER BY ts`,
        )
        .all(m[1], from, to, res);
    } else {
      rows = db
        .query(
          `SELECT * FROM samples
           WHERE board_chip_id = ?1 AND ts >= ?2 AND ts <= ?3 ORDER BY ts`,
        )
        .all(m[1], from, to);
    }
    return Response.json(rows.map(parseSampleRow));
  }

  m = p.match(/^\/api\/boards\/([^/]+)\/sessions$/);
  if (m && req.method === "GET") {
    const rows = db
      .query(
        "SELECT * FROM sessions WHERE board_chip_id = ? ORDER BY started_at DESC",
      )
      .all(m[1]);
    return Response.json(rows);
  }

  m = p.match(/^\/api\/sessions\/(\d+)$/);
  if (m && req.method === "GET") {
    const sess = db
      .query("SELECT * FROM sessions WHERE id = ?")
      .get(Number(m[1])) as any;
    if (!sess) return Response.json({ error: "not found" }, { status: 404 });
    const end = sess.ended_at ?? Date.now();
    const samples = db
      .query(
        `SELECT * FROM samples
         WHERE board_chip_id = ? AND ts >= ? AND ts <= ? ORDER BY ts`,
      )
      .all(sess.board_chip_id, sess.started_at, end)
      .map(parseSampleRow);
    return Response.json({ ...sess, samples });
  }

  return undefined;
}

async function patchBoard(
  db: Database,
  req: Request,
  chipId: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const name = (body as { name?: unknown })?.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return Response.json({ error: "name required" }, { status: 400 });
  }
  const res = db
    .query("UPDATE boards SET name = ? WHERE chip_id = ?")
    .run(name.trim(), chipId);
  if (res.changes === 0) {
    return Response.json({ error: "unknown board" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
```

Note the return type: `handleApi` is `Response | Promise<Response> | undefined` (the Task 4 stub and server already use this shape — the server awaits the result), so the PATCH branch can simply return the async `patchBoard(...)` promise while GET branches stay synchronous.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/api.test.ts && bun test tests/server.test.ts`
Expected: PASS (all). Server tests still pass — the server already awaits `handleApi`.

- [ ] **Step 5: Commit**

```bash
git add webapp/src/api.ts webapp/tests/api.test.ts
git commit -m "webapp: read API for boards, samples, and sessions"
```

---

### Task 6: Health endpoint

**Files:**
- Modify: `webapp/src/api.ts` (add one branch + helper)
- Test: `webapp/tests/health.test.ts`

**Interfaces:**
- Consumes: `parseSampleRow`, sessions/samples tables.
- Produces: `GET /api/boards/:chipId/health` →

```json
{
  "capacity_estimates": [{ "session_id": 1, "ended_at": 123, "est_mah": 15000 }],
  "capacity_est_mah": 15000,
  "regen_ratio": 0.1,
  "cycle_count": 4.2,
  "temp_min_c": -2,
  "temp_max_c": 41,
  "cell_spread_daily": [{ "day": "2026-08-03", "max_spread_mv": 45 }]
}
```

Rules (spec §4): capacity estimates come from **charge** sessions with SOC swing ≥ 50 (`est_mah = mah_delta / (end_soc - start_soc) * 100`); `capacity_est_mah` = median of estimates (null if none); `regen_ratio = regen_mah / used_mah` from latest sample (null if `used_mah` is 0); `cycle_count = used_mah / capacity_est_mah` (null without an estimate); temp extremes from sessions; `cell_spread_daily` = per-day max of (max nonzero cell − min nonzero cell) over samples.

- [ ] **Step 1: Write the failing tests**

`webapp/tests/health.test.ts`:

```ts
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

function seedChargeSession(opts: {
  startSoc: number;
  endSoc: number;
  mah: number;
  endedAt: number;
}) {
  db.query(
    `INSERT INTO sessions (board_chip_id, kind, started_at, ended_at, start_soc, end_soc,
      mah_delta, start_used_mah, start_regen_mah, last_sample_ts, last_active_ts,
      min_temp_c, max_temp_c)
     VALUES ('c024','charge', ?1 - 1000, ?1, ?2, ?3, ?4, 0, 0, ?1, ?1, 10, 35)`,
  ).run(opts.endedAt, opts.startSoc, opts.endSoc, opts.mah);
}

async function health(): Promise<any> {
  const url = new URL("http://x/api/boards/c024/health");
  const res = await handleApi(db, new Request(url), url)!;
  expect(res.status).toBe(200);
  return res.json();
}

describe("GET /api/boards/:chipId/health", () => {
  test("capacity from >=50% swing charge sessions, median, cycles, regen ratio", async () => {
    recordSample(db, makePayload({ used_mah: 30000, regen_mah: 3000 }), 5000);
    seedChargeSession({ startSoc: 10, endSoc: 90, mah: 12000, endedAt: 2000 }); // est 15000
    seedChargeSession({ startSoc: 20, endSoc: 80, mah: 7800, endedAt: 3000 }); // est 13000
    seedChargeSession({ startSoc: 60, endSoc: 90, mah: 4000, endedAt: 4000 }); // swing 30, ignored
    const h = await health();
    expect(h.capacity_estimates).toHaveLength(2);
    expect(h.capacity_est_mah).toBe(14000); // median of [13000, 15000]
    expect(h.regen_ratio).toBeCloseTo(0.1);
    expect(h.cycle_count).toBeCloseTo(30000 / 14000, 2);
    expect(h.temp_min_c).toBe(10);
    expect(h.temp_max_c).toBe(35);
  });

  test("nulls when there is no usable data", async () => {
    recordSample(db, makePayload({ used_mah: 0, regen_mah: 0 }), 1000);
    const h = await health();
    expect(h.capacity_est_mah).toBeNull();
    expect(h.cycle_count).toBeNull();
    expect(h.regen_ratio).toBeNull();
  });

  test("daily max cell spread", async () => {
    const day1 = Date.UTC(2026, 7, 1, 12); // 2026-08-01
    const day2 = Date.UTC(2026, 7, 2, 12);
    recordSample(db, makePayload({ cells_mv: [3800, ...Array(13).fill(3850), 3860] }), day1);
    recordSample(db, makePayload({ cells_mv: [3810, ...Array(13).fill(3850), 3855] }), day1 + 1000);
    recordSample(db, makePayload({ cells_mv: [3700, ...Array(13).fill(3850), 3900] }), day2);
    const h = await health();
    expect(h.cell_spread_daily).toEqual([
      { day: "2026-08-01", max_spread_mv: 60 },
      { day: "2026-08-02", max_spread_mv: 200 },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/health.test.ts`
Expected: FAIL — health route returns undefined → `res.status` throws.

- [ ] **Step 3: Implement the health branch**

Add to `webapp/src/api.ts`, inside `handleApi` before `return undefined`:

```ts
  m = p.match(/^\/api\/boards\/([^/]+)\/health$/);
  if (m && req.method === "GET") {
    return boardHealth(db, m[1]);
  }
```

Add at the bottom of the file:

```ts
function boardHealth(db: Database, chipId: string): Response {
  const chargeSessions = db
    .query(
      `SELECT id, ended_at, start_soc, end_soc, mah_delta
       FROM sessions
       WHERE board_chip_id = ? AND kind = 'charge' AND ended_at IS NOT NULL
         AND end_soc - start_soc >= 50
       ORDER BY ended_at`,
    )
    .all(chipId) as any[];
  const estimates = chargeSessions.map((s) => ({
    session_id: s.id,
    ended_at: s.ended_at,
    est_mah: Math.round((s.mah_delta / (s.end_soc - s.start_soc)) * 100),
  }));
  const sorted = estimates.map((e) => e.est_mah).sort((a, b) => a - b);
  const capacityEst = sorted.length
    ? sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : null;

  const latest = db
    .query(
      "SELECT used_mah, regen_mah FROM samples WHERE board_chip_id = ? ORDER BY ts DESC LIMIT 1",
    )
    .get(chipId) as any;
  const regenRatio =
    latest && latest.used_mah > 0 ? latest.regen_mah / latest.used_mah : null;
  const cycleCount =
    latest && capacityEst ? latest.used_mah / capacityEst : null;

  const temps = db
    .query(
      `SELECT MIN(min_temp_c) AS tmin, MAX(max_temp_c) AS tmax
       FROM sessions WHERE board_chip_id = ?`,
    )
    .get(chipId) as any;

  const spreadRows = db
    .query(
      `SELECT date(ts / 1000, 'unixepoch') AS day, cells_mv
       FROM samples WHERE board_chip_id = ? ORDER BY ts`,
    )
    .all(chipId) as any[];
  const byDay = new Map<string, number>();
  for (const r of spreadRows) {
    const cells = (JSON.parse(r.cells_mv) as number[]).filter((c) => c > 0);
    if (cells.length === 0) continue;
    const spread = Math.max(...cells) - Math.min(...cells);
    byDay.set(r.day, Math.max(byDay.get(r.day) ?? 0, spread));
  }

  return Response.json({
    capacity_estimates: estimates,
    capacity_est_mah: capacityEst,
    regen_ratio: regenRatio,
    cycle_count: cycleCount,
    temp_min_c: temps?.tmin ?? null,
    temp_max_c: temps?.tmax ?? null,
    cell_spread_daily: [...byDay.entries()].map(([day, max_spread_mv]) => ({
      day,
      max_spread_mv,
    })),
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test`
Expected: PASS (entire suite).

- [ ] **Step 5: Commit**

```bash
git add webapp/src/api.ts webapp/tests/health.test.ts
git commit -m "webapp: board health endpoint (capacity, cycles, cell spread)"
```

---

### Task 7: fake-owie simulator

**Files:**
- Create: `webapp/scripts/fake-owie.ts`

**Interfaces:**
- Consumes: the ingest HTTP contract only (posts to `http://localhost:8020/api/ingest`; env `OWIE_URL` overrides).
- Produces: `bun run scripts/fake-owie.ts [numBoards]` — simulates N boards (default 3) cycling idle → ride → idle → charge with realistic noise, one deliberately weak cell per board, warming temps during rides. Posts every 2 s (active) / 30 s (idle) scaled by `SPEEDUP` env (default 10× so sessions form quickly during development).

- [ ] **Step 1: Implement the simulator**

`webapp/scripts/fake-owie.ts`:

```ts
// Simulates Owie boards posting telemetry. Usage:
//   bun run scripts/fake-owie.ts [numBoards]
// Env: OWIE_URL (default http://localhost:8020), SPEEDUP (default 10)

const BASE_URL = process.env.OWIE_URL ?? "http://localhost:8020";
const SPEEDUP = Number(process.env.SPEEDUP ?? 10);
const NUM_BOARDS = Number(process.argv[2] ?? 3);

type Phase = "idle" | "ride" | "charge";

class FakeBoard {
  chipId: string;
  soc = 60 + Math.random() * 35;
  usedMah = Math.round(Math.random() * 50_000);
  regenMah = Math.round(this.usedMah * 0.1);
  uptimeS = 0;
  phase: Phase = "idle";
  phaseRemainingS = 30;
  weakCell = Math.floor(Math.random() * 15);
  capacityMah = 14000 + Math.random() * 2000;

  constructor(i: number) {
    this.chipId = (0xa000 + i).toString(16);
  }

  private nextPhase(): void {
    if (this.phase === "ride" || this.soc < 15) {
      this.phase = this.soc < 90 && Math.random() < 0.6 ? "charge" : "idle";
    } else if (this.phase === "charge" || this.soc > 95) {
      this.phase = "idle";
    } else {
      this.phase = Math.random() < 0.7 ? "ride" : "charge";
    }
    this.phaseRemainingS =
      this.phase === "idle" ? 60 + Math.random() * 120 : 300 + Math.random() * 600;
  }

  tick(dtS: number): Record<string, unknown> {
    this.uptimeS += dtS;
    this.phaseRemainingS -= dtS;
    if (this.phaseRemainingS <= 0) this.nextPhase();

    let currentMa = 0;
    if (this.phase === "ride") {
      currentMa = 4000 + Math.random() * 12000; // 4-16 A discharge
      if (Math.random() < 0.1) currentMa = -(1000 + Math.random() * 3000); // regen braking
    } else if (this.phase === "charge") {
      currentMa = -(3000 + Math.random() * 500);
    }

    const mahMoved = (Math.abs(currentMa) * dtS) / 3600;
    if (currentMa > 0) {
      this.usedMah += mahMoved;
      this.soc -= (mahMoved / this.capacityMah) * 100;
    } else if (currentMa < 0) {
      this.regenMah += mahMoved;
      this.soc += (mahMoved / this.capacityMah) * 100;
    }
    this.soc = Math.min(100, Math.max(0, this.soc));

    // 15S pack: ~3.0V empty to ~4.2V full per cell.
    const cellBase = 3000 + this.soc * 12;
    const cells = Array.from({ length: 15 }, (_, i) => {
      let v = cellBase + (Math.random() - 0.5) * 20;
      if (i === this.weakCell) v -= 30 + (100 - this.soc);
      return Math.round(v);
    });
    const totalMv = cells.reduce((a, b) => a + b, 0);
    const baseTemp = this.phase === "ride" ? 30 : 20;
    const temps = Array.from({ length: 5 }, () =>
      Math.round(baseTemp + (Math.random() - 0.5) * 4),
    );

    return {
      chip_id: this.chipId,
      bms_serial: 100000 + parseInt(this.chipId, 16),
      fw_version: "2.0.0-dev",
      uptime_s: Math.round(this.uptimeS),
      total_mv: totalMv,
      current_ma: Math.round(currentMa),
      bms_soc: Math.round(this.soc),
      overridden_soc: Math.round(this.soc),
      voltage_soc: Math.round(this.soc),
      cells_mv: cells,
      temps_c: temps,
      charging: this.phase === "charge",
      status_byte: this.phase === "charge" ? 0x20 : 0,
      used_mah: Math.round(this.usedMah),
      regen_mah: Math.round(this.regenMah),
    };
  }

  intervalS(): number {
    return this.phase === "idle" ? 30 : 2;
  }
}

const boards = Array.from({ length: NUM_BOARDS }, (_, i) => new FakeBoard(i));
console.log(
  `fake-owie: ${NUM_BOARDS} boards -> ${BASE_URL}/api/ingest (speedup ${SPEEDUP}x)`,
);

for (const b of boards) {
  (async () => {
    for (;;) {
      const dtS = b.intervalS();
      const payload = b.tick(dtS);
      try {
        const res = await fetch(`${BASE_URL}/api/ingest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.status !== 204) {
          console.error(`${b.chipId}: HTTP ${res.status} ${await res.text()}`);
        }
      } catch (e) {
        console.error(`${b.chipId}: ${e}`);
      }
      await Bun.sleep((dtS * 1000) / SPEEDUP);
    }
  })();
}
```

- [ ] **Step 2: Verify end-to-end against a live server**

Terminal 1: `bun run src/server.ts` (uses `owie.db` — delete it afterward if you want a clean slate)
Terminal 2: `bun run scripts/fake-owie.ts 3`, let it run ~60 s.
Then:

Run: `curl -s http://localhost:8020/api/boards | head -c 400`
Expected: JSON array with 3 boards, each with a `latest` sample.

Run: `curl -s "http://localhost:8020/api/boards/a000/sessions"`
Expected: at least one ride or charge session (speedup makes sessions form in under a minute).

Stop both processes. Run: `rm -f webapp/owie.db webapp/owie.db-*` (from repo root: clean dev artifacts).

- [ ] **Step 3: Add owie.db to gitignore and commit**

Append to the repo root `.gitignore` (create `webapp/.gitignore` if the root one doesn't exist):

```
webapp/owie.db*
webapp/node_modules/
webapp/frontend/node_modules/
webapp/frontend/dist/
```

```bash
git add webapp/scripts/fake-owie.ts .gitignore
git commit -m "webapp: fake-owie board simulator for hardware-free development"
```

---

### Task 8: Frontend scaffold + Fleet view

**Files:**
- Create: `webapp/frontend/package.json`, `webapp/frontend/tsconfig.json`, `webapp/frontend/vite.config.ts`, `webapp/frontend/index.html`
- Create: `webapp/frontend/src/main.tsx`, `webapp/frontend/src/App.tsx`, `webapp/frontend/src/api.ts`, `webapp/frontend/src/live.ts`, `webapp/frontend/src/styles.css`
- Create: `webapp/frontend/src/views/Fleet.tsx`

**Interfaces:**
- Consumes: `GET /api/boards`, WS `{ type: "sample", sample }` messages.
- Produces: hash-based routes `#/` (Fleet), `#/board/:chipId` (Task 9), `#/sessions` (Task 9). `src/api.ts` exports typed fetch helpers + the `Sample`/`Board`/`Session` types (frontend copies — no cross-package imports). `src/live.ts` exports `useLiveSamples(onSample: (s: Sample) => void)` — a hook that maintains a reconnecting WebSocket. Task 9 builds on all of these.
- Status semantics on Fleet cards: `charging` if latest sample charging; `riding` if `current_ma > 500`; `offline` if no sample for 2 minutes; else `idle`.

- [ ] **Step 1: Scaffold the Vite project**

`webapp/frontend/package.json`:

```json
{
  "name": "owie-telemetry-frontend",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "uplot": "^1.6.30"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0"
  }
}
```

Run: `cd webapp/frontend && bun install`

`webapp/frontend/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`webapp/frontend/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8020",
      "/ws": { target: "ws://localhost:8020", ws: true },
    },
  },
});
```

`webapp/frontend/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Owie Telemetry</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: API helpers and live hook**

`webapp/frontend/src/api.ts`:

```ts
export interface Sample {
  id: number;
  ts: number;
  chip_id: string;
  uptime_s: number;
  total_mv: number;
  current_ma: number;
  bms_soc: number;
  overridden_soc: number;
  voltage_soc: number;
  cells_mv: number[];
  temps_c: number[];
  charging: boolean;
  status_byte: number;
  used_mah: number;
  regen_mah: number;
}

export interface Board {
  chip_id: string;
  name: string;
  bms_serial: number;
  fw_version: string;
  first_seen: number;
  last_seen: number;
  latest: Sample | null;
}

export interface Session {
  id: number;
  board_chip_id: string;
  kind: "ride" | "charge";
  started_at: number;
  ended_at: number | null;
  start_soc: number;
  end_soc: number;
  mah_delta: number;
  wh_delta: number;
  min_cell_mv: number | null;
  max_cell_mv: number | null;
  max_cell_spread_mv: number | null;
  min_temp_c: number | null;
  max_temp_c: number | null;
  sample_count: number;
}

export interface Health {
  capacity_estimates: { session_id: number; ended_at: number; est_mah: number }[];
  capacity_est_mah: number | null;
  regen_ratio: number | null;
  cycle_count: number | null;
  temp_min_c: number | null;
  temp_max_c: number | null;
  cell_spread_daily: { day: string; max_spread_mv: number }[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchBoards = () => get<Board[]>("/api/boards");
export const fetchSamples = (chipId: string, from: number, to: number, res?: number) =>
  get<Sample[]>(
    `/api/boards/${chipId}/samples?from=${from}&to=${to}${res ? `&res=${res}` : ""}`,
  );
export const fetchSessions = (chipId: string) =>
  get<Session[]>(`/api/boards/${chipId}/sessions`);
export const fetchSessionDetail = (id: number) =>
  get<Session & { samples: Sample[] }>(`/api/sessions/${id}`);
export const fetchHealth = (chipId: string) =>
  get<Health>(`/api/boards/${chipId}/health`);
export const renameBoard = (chipId: string, name: string) =>
  fetch(`/api/boards/${chipId}`, { method: "PATCH", body: JSON.stringify({ name }) });
```

`webapp/frontend/src/live.ts`:

```ts
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
```

- [ ] **Step 3: App shell with hash routing, Fleet view, styles**

`webapp/frontend/src/main.tsx`:

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "uplot/dist/uPlot.min.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

`webapp/frontend/src/App.tsx`:

```tsx
import { useEffect, useState } from "react";
import Fleet from "./views/Fleet";

// Task 9 adds these imports and route branches:
// import BoardDetail from "./views/BoardDetail";
// import Sessions from "./views/Sessions";

function useHashRoute(): string {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const fn = () => setHash(location.hash || "#/");
    addEventListener("hashchange", fn);
    return () => removeEventListener("hashchange", fn);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHashRoute();
  let view = <Fleet />;
  const boardMatch = hash.match(/^#\/board\/([^/]+)$/);
  if (boardMatch) {
    view = <p className="placeholder">Board view coming in Task 9 ({boardMatch[1]})</p>;
  } else if (hash === "#/sessions") {
    view = <p className="placeholder">Sessions view coming in Task 9</p>;
  }
  return (
    <div className="app">
      <nav>
        <a href="#/" className="brand">⚡ Owie Telemetry</a>
        <a href="#/">Fleet</a>
        <a href="#/sessions">Sessions</a>
      </nav>
      <main>{view}</main>
    </div>
  );
}
```

`webapp/frontend/src/views/Fleet.tsx`:

```tsx
import { useEffect, useState } from "react";
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

  useLiveSamples((s) => {
    setNow(Date.now());
    setBoards((prev) => {
      const known = prev.some((b) => b.chip_id === s.chip_id);
      if (!known) {
        // New board appeared: refetch the full list for its name/metadata.
        fetchBoards().then(setBoards).catch(console.error);
        return prev;
      }
      return prev.map((b) =>
        b.chip_id === s.chip_id ? { ...b, latest: s, last_seen: s.ts } : b,
      );
    });
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
```

`webapp/frontend/src/styles.css`:

```css
:root {
  color-scheme: light dark;
  --bg: light-dark(#f5f6f8, #14161a);
  --card: light-dark(#ffffff, #1e2128);
  --text: light-dark(#1a1d23, #e8eaee);
  --muted: light-dark(#667085, #9aa3b2);
  --accent: #4f8ef7;
  --ok: #3fb950;
  --warn: #d29922;
  --bad: #f85149;
  font-family: system-ui, sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); }
.app { max-width: 1100px; margin: 0 auto; padding: 0 1rem 3rem; }
nav { display: flex; gap: 1rem; align-items: center; padding: 1rem 0; }
nav a { color: var(--muted); text-decoration: none; font-weight: 500; }
nav a.brand { color: var(--text); font-size: 1.2rem; margin-right: auto; }
.placeholder { color: var(--muted); }
.fleet { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1rem; }
.card { background: var(--card); border-radius: 10px; padding: 1rem; text-decoration: none;
  color: inherit; border: 1px solid transparent; }
.card:hover { border-color: var(--accent); }
.card header { display: flex; justify-content: space-between; align-items: center; }
.card h2 { margin: 0; font-size: 1.05rem; }
.card dl { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; margin: .8rem 0 0; }
.card dt { color: var(--muted); font-size: .75rem; text-transform: uppercase; }
.card dd { margin: 0; font-size: 1.15rem; font-variant-numeric: tabular-nums; }
.card footer { margin-top: .8rem; color: var(--muted); font-size: .75rem; }
.badge { font-size: .7rem; padding: .15rem .5rem; border-radius: 99px; text-transform: uppercase; }
.badge.charging { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
.badge.riding { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
.badge.offline { background: color-mix(in srgb, var(--bad) 15%, transparent); color: var(--bad); }
.badge.idle { background: color-mix(in srgb, var(--muted) 20%, transparent); color: var(--muted); }
.cells { display: flex; gap: 4px; align-items: flex-end; height: 120px; }
.cells .cell { flex: 1; background: var(--accent); border-radius: 3px 3px 0 0; position: relative; }
.cells .cell.min { background: var(--bad); }
.cells .cell.max { background: var(--ok); }
.cells .cell span { position: absolute; bottom: -1.4rem; left: 50%; transform: translateX(-50%);
  font-size: .65rem; color: var(--muted); }
.panel { background: var(--card); border-radius: 10px; padding: 1rem; margin-bottom: 1rem; }
.panel h3 { margin-top: 0; }
table.sessions { width: 100%; border-collapse: collapse; }
table.sessions th, table.sessions td { text-align: left; padding: .5rem; border-bottom: 1px solid
  color-mix(in srgb, var(--muted) 25%, transparent); font-variant-numeric: tabular-nums; }
table.sessions th { color: var(--muted); font-size: .75rem; text-transform: uppercase; }
.stat-row { display: flex; gap: 2rem; flex-wrap: wrap; }
.stat-row .stat b { display: block; font-size: 1.3rem; }
.stat-row .stat span { color: var(--muted); font-size: .8rem; }
select, input { background: var(--card); color: var(--text); border: 1px solid var(--muted);
  border-radius: 6px; padding: .3rem .5rem; }
```

- [ ] **Step 4: Verify with typecheck, build, and live data**

Run: `cd webapp/frontend && bun run build`
Expected: `tsc` clean, Vite build emits `dist/`.

Then run the stack (three terminals or backgrounded):
1. `cd webapp && bun run dev` (backend on 8020)
2. `cd webapp && bun run fake 3`
3. `cd webapp/frontend && bun run dev` (Vite on 5173)

Open `http://localhost:5173` — expect 3 board cards updating live (status flips between idle/riding/charging within a couple of minutes thanks to SPEEDUP). Verify in the browser that cards update without reloading.

- [ ] **Step 5: Commit**

```bash
git add webapp/frontend
git commit -m "webapp: Vite/React frontend scaffold with live fleet view"
```

---

### Task 9: Board detail and Sessions views

**Files:**
- Create: `webapp/frontend/src/components/CellBars.tsx`
- Create: `webapp/frontend/src/components/TimeSeries.tsx`
- Create: `webapp/frontend/src/views/BoardDetail.tsx`
- Create: `webapp/frontend/src/views/Sessions.tsx`
- Modify: `webapp/frontend/src/App.tsx` (wire the routes)

**Interfaces:**
- Consumes: everything from Task 8's `api.ts`/`live.ts`; `GET /api/boards/:id/samples|sessions|health`, `GET /api/sessions/:id`.
- Produces: routes `#/board/:chipId` and `#/sessions` fully working.

- [ ] **Step 1: CellBars component**

`webapp/frontend/src/components/CellBars.tsx`:

```tsx
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
```

- [ ] **Step 2: uPlot wrapper**

`webapp/frontend/src/components/TimeSeries.tsx`:

```tsx
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
```

- [ ] **Step 3: BoardDetail view**

`webapp/frontend/src/views/BoardDetail.tsx`:

```tsx
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
```

- [ ] **Step 4: Sessions view**

`webapp/frontend/src/views/Sessions.tsx`:

```tsx
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
```

- [ ] **Step 5: Wire routes in App.tsx**

Replace the route section of `webapp/frontend/src/App.tsx`:

```tsx
import { useEffect, useState } from "react";
import BoardDetail from "./views/BoardDetail";
import Fleet from "./views/Fleet";
import Sessions from "./views/Sessions";

function useHashRoute(): string {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const fn = () => setHash(location.hash || "#/");
    addEventListener("hashchange", fn);
    return () => removeEventListener("hashchange", fn);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHashRoute();
  let view = <Fleet />;
  const boardMatch = hash.match(/^#\/board\/([^/]+)$/);
  if (boardMatch) view = <BoardDetail chipId={boardMatch[1]} />;
  else if (hash === "#/sessions") view = <Sessions />;
  return (
    <div className="app">
      <nav>
        <a href="#/" className="brand">⚡ Owie Telemetry</a>
        <a href="#/">Fleet</a>
        <a href="#/sessions">Sessions</a>
      </nav>
      <main>{view}</main>
    </div>
  );
}
```

- [ ] **Step 6: Verify**

Run: `cd webapp/frontend && bun run build`
Expected: clean typecheck + build.

With backend + fake-owie + Vite dev running (as in Task 8 Step 4), verify in the browser:
- Clicking a fleet card opens board detail; cell bars animate live; history charts render; health panel shows capacity/cycles once a big charge session has completed (fake-owie at 10× produces one within ~10 minutes — seed faster with `SPEEDUP=50`).
- `#/sessions` lists sessions; clicking a row shows the current/SOC chart; filters work.

- [ ] **Step 7: Commit**

```bash
git add webapp/frontend/src
git commit -m "webapp: board detail and sessions views with uPlot charts"
```

---

### Task 10: Production serving + docs + final verification

**Files:**
- Modify: `webapp/package.json` (build script)
- Create: `webapp/README.md`
- Modify: `README.md` (repo root — one short section pointing at webapp/)

**Interfaces:**
- Consumes: everything.
- Produces: `bun run build && bun start` serves the whole app on port 8020 from a single process.

- [ ] **Step 1: Add the build script**

In `webapp/package.json` scripts, add:

```json
"build": "cd frontend && bun install && bun run build"
```

- [ ] **Step 2: Write webapp/README.md**

```markdown
# Owie Telemetry

Self-hosted LAN dashboard for battery data pushed by [Owie](../README.md)
boards: live monitoring, ride/charge session history, per-cell voltages,
and battery health trends.

## Run

Requires [Bun](https://bun.sh) ≥ 1.1.

    cd webapp
    bun install
    bun run build     # builds the frontend into frontend/dist
    bun start         # serves everything on http://<host>:8020

Data lands in `webapp/owie.db` (SQLite). Env vars: `OWIE_PORT`, `OWIE_DB`.

## Develop

    bun run dev                 # backend, auto-reload
    bun run fake 3              # simulate 3 boards (SPEEDUP=10x default)
    cd frontend && bun run dev  # Vite on :5173, proxies /api and /ws

Tests: `bun test`

## Pointing boards at it

Boards POST JSON to `http://<host>:8020/api/ingest`. The payload contract
is defined in `docs/superpowers/specs/2026-08-03-owie-battery-telemetry-webapp-design.md`
(§1) and `src/ingest.ts`. Firmware-side support is phase 2 — until then,
`scripts/fake-owie.ts` demonstrates the contract.
```

- [ ] **Step 3: Add a section to the repo root README.md**

Append after the Features section:

```markdown
# Telemetry webapp

The `webapp/` directory contains a self-hosted LAN dashboard that records
telemetry from Owie boards — live cell voltages, ride/charge sessions, and
battery health over time. See [webapp/README.md](webapp/README.md).
```

- [ ] **Step 4: Full verification**

Run: `cd webapp && bun test`
Expected: whole suite passes.

Run: `bun run build && bun start` (in `webapp/`), then in another terminal `bun run fake 5`, then open `http://localhost:8020` directly (no Vite).
Expected: the production bundle serves; 5 boards appear and update live; hash routes work when loaded fresh (SPA fallback).

Stop processes, `rm -f webapp/owie.db*`.

- [ ] **Step 5: Commit**

```bash
git add webapp/package.json webapp/README.md README.md
git commit -m "webapp: production build/serve, docs"
```
