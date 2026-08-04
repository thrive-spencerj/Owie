---
name: owie-webapp
description: Use when running, developing, testing, or debugging the Owie telemetry webapp (webapp/) — starting the server or dashboard, simulating boards with fake-owie, resetting the SQLite database, changing the ingest payload contract, or diagnosing boards showing offline / sessions not forming.
---

# Owie telemetry webapp

## Overview
`webapp/` is a Bun + SQLite + Vite/React app that ingests battery telemetry from Owie boards (`POST /api/ingest`), derives ride/charge sessions, and serves a live dashboard. One process, port 8020 (`OWIE_PORT`). All commands below run from `webapp/`.

## Quick reference
| Task | Command |
|---|---|
| Production (build + serve on :8020) | `bun run build && bun start` |
| Dev backend (auto-reload) | `bun run dev` |
| Dev frontend (Vite :5173, proxies /api + /ws) | `cd frontend && bun run dev` |
| Simulate N boards | `bun run fake N` (`SPEEDUP=30` forms sessions in ~1 min; default 10) |
| Backend tests | `bun test` |
| Full verification gate | `bun test && bunx tsc --noEmit && (cd frontend && bun run build)` |
| Reset data | stop server, `rm -f owie.db*` |

Data lives in `webapp/owie.db` (SQLite WAL; `OWIE_DB` overrides, tests use `:memory:`). Schema auto-creates on start. `owie.db*` is gitignored — never commit it.

## Changing the ingest payload contract
The v1 contract is pinned in `docs/superpowers/specs/2026-08-03-owie-battery-telemetry-webapp-design.md` §1. A field change must touch ALL of:

1. `webapp/src/types.ts` — `IngestPayload`
2. `webapp/src/ingest.ts` — `validatePayload` (+ `NUMBER_FIELDS`), `recordSample` INSERT
3. `webapp/src/db.ts` — `samples` schema
4. `webapp/src/api.ts` — `parseSampleRow`
5. `webapp/frontend/src/api.ts` — frontend `Sample` type
6. `webapp/scripts/fake-owie.ts` — simulator payload
7. **Golden string, byte-identical in BOTH:** `webapp/tests/firmware-contract.test.ts` and firmware `test/test_telemetry_serializer/telemetry_serializer_test.cpp`
8. Firmware: `lib/telemetry/telemetry_serializer.{h,cc}` + `src/telemetry.cpp` `fillSnapshot`

The golden-string pair is the drift tripwire — but only if you update both; run `bun test` AND `pio test -e native -f test_telemetry_serializer` (see the owie-build skill).

## Behavior constants (where "why is it doing that" answers live)
- Fleet "offline" badge: no sample for 2 min (`frontend/src/views/Fleet.tsx` `OFFLINE_MS`); riding badge: `current_ma > 500`.
- Sessionizer (`src/sessionizer.ts`): ride opens after 3 consecutive samples > 500 mA discharge; charge opens on the charging flag (charge preempts ride); both close after 5 idle minutes; wh_delta is |current| throughput, regen adds to it.
- Board cadence: 2 s active / 30 s idle — an idle board is never "offline" unless 4 posts are missed.
- Boards auto-register on first sample, named `Owie-<CHIPID>`; rename via ✏️ on board detail (`PATCH /api/boards/:chipId`).

## Common mistakes
- Diagnosing "no sessions forming" with default fake-owie speed — takes many minutes; use `SPEEDUP=30`+.
- Editing the golden JSON in only one of its two homes — the contract tests then pass individually while the stack is broken.
- Forgetting the frontend in verification — `bun test` doesn't typecheck TSX; the gate needs `cd frontend && bun run build`.
- Leaving a stale `bun start` holding :8020 — `pkill -f "bun.*src/server.ts"` before restarting.
- Firmware-side setup (board settings page, OTA flash) is NOT this skill — see `owie-flash-ota` and the Telemetry section docs in `webapp/README.md`.
