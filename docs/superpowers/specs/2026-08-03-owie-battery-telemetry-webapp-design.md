# Owie Battery Telemetry Webapp — Design

Date: 2026-08-03
Status: Approved by Spencer (chat), pending spec review

## Purpose

A self-hosted, LAN-only webapp that records and tracks battery/cell/BMS data
pushed from Owie boards whenever they join the home network. It supports many
boards, tracks ride and charge sessions, records individual cell voltages over
time, surfaces battery health trends, and shows live telemetry.

Deliberately simple: one Bun process, one SQLite file, a Vite/React frontend.
No Docker, no auth, no cloud. Data never leaves the LAN.

## Decisions already made

- **Hosting:** self-hosted on the local network. Plain HTTP — the ESP8266
  cannot comfortably do TLS.
- **Ingestion:** firmware pushes snapshots (phase 2 adds the firmware module);
  a pull path for raw-packet debugging is explicitly deferred.
- **Scale:** personal fleet (dozens of boards max, one household). No accounts.
- **Stack:** Bun + TypeScript backend (`Bun.serve`, `bun:sqlite`), Vite + React
  frontend, all under `webapp/` in this repo.

## Architecture

```
Owie boards ──HTTP POST /api/ingest──▶ Bun server ──▶ SQLite (owie.db)
                                          │
        browser ◀──WebSocket /ws──────────┴──▶ serves built Vite frontend
```

One `Bun.serve` process handles everything:

- `POST /api/ingest` — telemetry intake from boards (or the fake-owie script).
- `GET /api/*` — JSON read endpoints for the frontend (boards, samples,
  sessions, health).
- `GET /ws` — WebSocket; the server fans each accepted sample out to all
  connected browsers immediately after writing it.
- Static file serving of `webapp/frontend/dist` in production. During
  development the Vite dev server runs separately and proxies `/api` and `/ws`
  to the Bun server.

## Components

### 1. Ingest endpoint

`POST /api/ingest`, `application/json`. Payload (all fields required unless
noted):

| field | type | notes |
|---|---|---|
| `chip_id` | string | `"c024"`-style ESP chip ID; board identity |
| `bms_serial` | number | captured BMS serial, 0 if not yet seen |
| `fw_version` | string | Owie version string |
| `uptime_s` | number | seconds since boot; reboot detection |
| `total_mv` | number | pack voltage |
| `current_ma` | number | signed; positive = discharge |
| `bms_soc` | number | BMS-reported % |
| `overridden_soc` | number | Owie-spoofed % |
| `voltage_soc` | number | fuel gauge voltage-based % |
| `cells_mv` | number[15] | individual cell millivolts |
| `temps_c` | number[5] | thermistor °C |
| `charging` | boolean | from BMS status byte |
| `status_byte` | number | raw status byte for the remaining flags |
| `used_mah` | number | cumulative discharged mAh (fuel gauge) |
| `regen_mah` | number | cumulative recharged mAh (fuel gauge) |

Behavior:

- Unknown `chip_id` auto-creates a `boards` row (no registration step).
- Server timestamps samples on arrival (boards have no RTC).
- Validation rejects malformed payloads with 400; a sample failing validation
  is dropped, never partially written.
- Response 204. Boards do not retry failed posts in v1; the fuel gauge's
  cumulative counters make lifetime stats robust to missed samples.

Expected cadence from firmware: every 2 s while active (|current| above a
small threshold, or charging), every 30 s while idle.

### 2. Storage (`bun:sqlite`, WAL mode, single `owie.db`)

- `boards` — `chip_id` (PK), `name` (user-editable, defaults to
  `Owie-<CHIP_ID>`), `bms_serial`, `fw_version`, `first_seen`, `last_seen`.
- `samples` — `id`, `board_chip_id`, `ts`, `total_mv`, `current_ma`,
  `bms_soc`, `overridden_soc`, `voltage_soc`, `cells_mv` (JSON array),
  `temps_c` (JSON array), `charging`, `status_byte`, `used_mah`, `regen_mah`,
  `uptime_s`. Index on `(board_chip_id, ts)`.
- `sessions` — `id`, `board_chip_id`, `kind` (`ride` | `charge`),
  `started_at`, `ended_at` (NULL while open), plus derived stats maintained
  incrementally: `start_soc`, `end_soc`, `mah_delta`, `wh_delta`,
  `min_cell_mv`, `max_cell_mv`, `max_cell_spread_mv`, `min_temp_c`,
  `max_temp_c`, `sample_count`.

No retention/pruning in v1. At personal-fleet rates SQLite will stay small for
years; revisit if `owie.db` ever becomes a problem.

### 3. Sessionizer (runs synchronously on each ingested sample)

- **Charge session** opens when `charging` becomes true; closes when
  `charging` is false or no samples arrive for 5 minutes.
- **Ride session** opens on sustained discharge: `current_ma > 500` for 3
  consecutive samples. Closes after 5 minutes with no sample above the
  threshold (or no samples at all — e.g. board left WiFi range mid-ride;
  `ended_at` is then the last sample's timestamp).
- A board has at most one open session; charging takes precedence (a charge
  start closes an open ride session).
- Stats update incrementally on each sample; `wh_delta` integrates
  `total_mv × current_ma` over inter-sample intervals.
- On server startup, any session still open in the DB is closed if its last
  sample is older than the idle timeout (with `ended_at` = that sample's
  timestamp); otherwise it stays open and continues normally.

### 4. Read API

- `GET /api/boards` — fleet list with latest sample inlined.
- `PATCH /api/boards/:chipId` — rename.
- `GET /api/boards/:chipId/samples?from&to&res` — time series; `res` selects
  raw vs downsampled (server-side bucketing for long ranges).
- `GET /api/boards/:chipId/sessions` and `GET /api/sessions/:id` — session
  list/detail (detail includes its sample slice).
- `GET /api/boards/:chipId/health` — derived analytics: cell-spread trend,
  capacity estimates from charge sessions covering ≥50% SOC swing
  (`mah_delta / soc_delta × 100`), regen ratio, temp extremes, cycle count
  approximation from cumulative mAh.

### 5. Frontend (Vite + React, TypeScript)

Three views:

1. **Fleet** — card per board: name, live SOC, voltage, current, temp,
   charging/riding/idle/offline status (offline = no sample for 2 minutes),
   last-seen. Live via WebSocket.
2. **Board detail** — live cell-voltage bar chart (15 bars, min/max/spread
   highlighted), temps, current; historical charts (voltage, current, SOC,
   per-cell overlay, cell spread) with time-range picker; health panel with
   the trends from `/api/health`.
3. **Sessions** — filterable list (board, kind, date) with per-session stats;
   click-through to a session detail chart.

Charting library: uPlot, bundled locally — tiny, fast with many series, and
no CDN dependency since the app must work on an offline LAN.

### 6. Dev tooling

- `webapp/scripts/fake-owie.ts` — simulates N boards posting realistic
  ride/charge/idle telemetry to `/api/ingest` (state machine with noise,
  cell imbalance, temperature drift). Enables full UI development with no
  hardware.
- `bun test` for backend units; the sessionizer and ingest validation are the
  logic-heavy targets. Frontend gets type-checking + a smoke test; visual
  correctness is verified against fake-owie data.

## Phase 2 — firmware telemetry module (separate plan)

Out of scope for the webapp implementation plan, designed here so the payload
contract above is authoritative:

- New `telemetry` module: when station-mode WiFi is connected, POST the
  snapshot to `http://<collector_host>/api/ingest` on the active/idle cadence.
- `settings.proto` additions: `telemetry_enabled` (bool),
  `telemetry_url` (string). Exposed on the settings page.
- Non-blocking HTTP (ESPAsyncTCP-based client), fire-and-forget, no buffering
  of missed samples (RAM constraint).

## Error handling summary

- Malformed ingest → 400, dropped, counted in a server log line.
- Board reboots (uptime decreases) → recorded; cumulative mAh counters come
  from NVS-backed fuel gauge so they remain monotonic across reboots.
- Server restart → WAL keeps DB consistent; open sessions resolved by idle
  rule; browsers auto-reconnect the WebSocket.
- Boards dropping off WiFi mid-ride → session closes by timeout with honest
  `ended_at`; no interpolation of missing data.

## Success criteria

- `bun start` in `webapp/` serves the dashboard on the LAN.
- `fake-owie.ts` with 5 simulated boards produces a live-updating fleet view,
  correct ride/charge sessions, and plausible health trends.
- Ingest handles a real board's payload shape (verified against firmware in
  phase 2).
