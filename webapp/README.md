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

Boards running this firmware have a **Settings → Telemetry** section in the
board's own web UI: a "Telemetry collector" field (`host` or `host:port`,
port defaults to 8020) and an enable checkbox. Once enabled and the board is
on your station WiFi, it POSTs a snapshot to `http://<host>:<port>/api/ingest`
automatically — every 2 s while riding or charging, every 30 s while idle.

No hardware handy? `scripts/fake-owie.ts` simulates one or more boards
against this same endpoint for local development.

The payload contract is defined in
`docs/superpowers/specs/2026-08-03-owie-battery-telemetry-webapp-design.md`
(§1) and `src/ingest.ts`, and is pinned by `tests/firmware-contract.test.ts`
here and by the firmware's native serializer test
(`test/test_telemetry_serializer`).
