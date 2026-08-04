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
