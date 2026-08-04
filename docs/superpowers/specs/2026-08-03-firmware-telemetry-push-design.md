# Owie Firmware Telemetry Push (Phase 2) — Design

Date: 2026-08-03
Status: Approved by Spencer (chat)

## Purpose

Firmware-side half of the battery telemetry system: when an Owie board is on
station-mode WiFi (e.g. the baked-in `wheeels` network), it POSTs battery
snapshots to the self-hosted webapp's `/api/ingest` endpoint (see
`2026-08-03-owie-battery-telemetry-webapp-design.md` §1 for the payload
contract — that contract is authoritative and unchanged: **v1 fields only**,
no PowerStats/battery-profile extensions in this phase).

## Decisions

- **v1 payload contract only** (user decision): the 16 fields the webapp
  validates today. PowerStats (cell resistance, Wh) and SoH come in a later
  phase, extending firmware and webapp together.
- **Settings-page configuration only** (user decision): no baked-in collector
  address. Telemetry is off until configured per board.
- **Transport:** raw `AsyncClient` (ESPAsyncTCP — already a transitive
  dependency), hand-rolled `POST /api/ingest HTTP/1.1` with
  `Connection: close`. Fire-and-forget: no retries, no buffering (spec v1
  behavior; the fuel gauge's cumulative counters keep lifetime stats correct
  across gaps). At most one request in flight; ticks during an in-flight
  request are skipped. A 5 s one-shot task force-closes a stuck connection.
- **JSON:** `snprintf` into a static buffer (768 bytes) in a pure serializer
  function — no heap-allocated JSON document. All values are numeric except
  `chip_id` (hex string) and `fw_version` (compile-time constant), so no
  escaping is needed.

## Settings

`proto/settings.proto` additions (next free field numbers; 5 and 11 stay
reserved):

- `string telemetry_host = 14;` — `host` or `host:port` of the collector
  (port defaults to 8020, path fixed at `/api/ingest`). Storing host:port
  instead of a full URL keeps firmware parsing to one `:` split.
  `proto/settings.options`: `SettingsMsg.telemetry_host max_size:63`.
- `bool telemetry_enabled = 15;`

Settings page (`data/settings.html`): a "Telemetry" section with a collector
host text input (`%TELEMETRY_HOST%`) and an enable checkbox
(`%TELEMETRY_ENABLED%`), submitted with the existing settings form. The
`/settings` POST handler in `src/network.cpp` validates length ≤ 63 and
persists both fields. The page must pass the stray-`%` audit (template
processor footgun).

## Module layout

- `lib/telemetry/telemetry_serializer.h/.cc` — pure, Arduino-free:
  `size_t buildTelemetryJson(char* out, size_t outSize, const TelemetrySnapshot& s)`
  where `TelemetrySnapshot` is a plain struct carrying every payload field.
  Returns bytes written, 0 if the buffer is too small. Unit-tested in the
  `native` env (`test/test_telemetry_serializer`), including a golden-JSON
  test whose field list matches the webapp's `validatePayload` exactly.
- `src/telemetry.cpp` + `include/telemetry.h` — Arduino side:
  `void setupTelemetry(BmsRelay* relay)` called from `bms_setup()`. Registers
  a recurring TaskQueue task (500 ms) that posts when ALL of: telemetry
  enabled, `WiFi.status() == WL_CONNECTED`, no request in flight, and the
  cadence is due — 2 s when active (`|current_ma| > 500` or charging), 30 s
  when idle. Snapshot values come from the same `BmsRelay` getters the web
  UI uses.
- `include/version.h` — hoist the Owie version string (currently a local in
  `network.cpp`) to a single `OWIE_VERSION` constant used by both the web UI
  and the telemetry payload.
- `BmsRelay::getLastStatusByte()` — new one-line getter (the raw status byte
  is currently private; the payload needs it).

## Payload field sources

| field | source |
|---|---|
| `chip_id` | full 32-bit `ESP.getChipId()` as lowercase hex, no padding, no `Owie-` prefix (the webapp derives the display name; full ID avoids 16-bit collisions across a fleet) |
| `bms_serial` | `relay->getCapturedBMSSerial()` |
| `fw_version` | `OWIE_VERSION` |
| `uptime_s` | `millis() / 1000` |
| `total_mv` | `relay->getTotalVoltageMillivolts()` |
| `current_ma` | `relay->getCurrentMilliamps()` |
| `bms_soc` | `relay->getBmsReportedSOC()` |
| `overridden_soc` | `relay->getOverriddenSOC()` |
| `voltage_soc` | `relay->getBatteryFuelGauge().getVoltageBasedSoc()` |
| `cells_mv[15]` | `relay->getCellMillivolts()` |
| `temps_c[5]` | `relay->getTemperaturesCelsius()` |
| `charging` | `relay->isCharging()` |
| `status_byte` | `relay->getLastStatusByte()` (new getter) |
| `used_mah` | `relay->getUsedChargeMah()` |
| `regen_mah` | `relay->getRegeneratedChargeMah()` |

## Error handling

- WiFi down / telemetry disabled / empty host → tick is a cheap no-op.
- Connect/send failure → connection freed, next tick retries naturally.
- Stuck connection → force-closed by 5 s timeout task.
- Collector 4xx/5xx → ignored (response is only drained); the webapp logs
  rejects on its side.

## Verification

- `pio test -e native -f test_telemetry_serializer` — serializer unit tests
  (baseline: `test_battery_fuel_gauge` has 2 known pre-existing failures;
  they must not increase).
- `pio run -e d1_mini_lite_clone` — firmware builds.
- Stray-`%` audit on `data/settings.html`.
- End-to-end contract check without hardware: pipe the serializer's golden
  JSON through the webapp's `validatePayload` (webapp test addition).
- On-hardware verification (OTA flash, board appears in webapp) is left to
  Spencer.
