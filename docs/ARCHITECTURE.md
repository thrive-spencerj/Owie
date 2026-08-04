# Owie Architecture

Owie is ESP8266 firmware that sits as a **man-in-the-middle on the UART line
between a OneWheel's Battery Management System (BMS) and its motor controller
("mainboard" / MB)**. By intercepting, rewriting, and selectively dropping
packets in that stream, it defeats BMS↔controller pairing, fixes battery
percentage reporting for aftermarket/extended batteries, and exposes live
battery telemetry over WiFi.

```
                 ┌────────────────────────────────────────┐
   BMS  ──UART──▶│                Owie (ESP8266)          │──UART──▶  Mainboard
  (white wire    │  BmsRelay: parse → inspect/modify →    │  (white wire to MB,
   from BMS      │  recompute CRC → forward (or drop)     │   B line emulated
   → RX)         │                                        │   on D1 via IRQ)
                 │  ├─ PacketTracker (stats/replay)       │
                 │  ├─ BatteryFuelGauge (SOC estimate)    │
                 │  └─ Web UI / WebSocket / OTA (SoftAP)  │
                 └────────────────────────────────────────┘
```

## Directory layout

| Path | Purpose |
|---|---|
| `src/` | ESP8266-specific entry points: boot, WiFi/web server, OTA, recovery, settings persistence |
| `lib/bms/` | Hardware-independent core: packet framing, relay/parsers, fuel gauge, task queue. Unit-testable on the host (`pio test -e native`) |
| `lib/nvs/` | Work-in-progress replacement key-value flash storage (protobuf pages with sequence numbers and tombstones) |
| `include/` | Headers for the `src/` modules |
| `data/` | Web UI pages. Minified by `pio_tools/gen_data.py` at build time and embedded into flash as PROGMEM byte arrays (no filesystem) |
| `proto/` | nanopb protobuf schemas: `settings.proto` (persisted settings + battery state), `nvs.proto` (WIP storage) |
| `test/` | Host-native Unity tests for the `lib/bms/` core |

## Boot flow (`src/main.cpp`)

1. `loadSettings()` decodes the protobuf settings blob from flash.
2. `maybeLockOnStartup()` — if locking is armed and the previous boot was a
   quick power cycle, mark the board locked.
3. **Recovery check**: `quick_power_cycle_count` is incremented on every boot
   and reset back to zero by a 5-second timer. Two power cycles in under ~5
   seconds therefore leave a count > 1, which boots the board into
   **recovery mode** (`src/recovery.cpp`): settings are nuked and an open
   `Owie-recovery` AP is started that serves only the OTA update page. This is
   the escape hatch for a bad flash or forgotten password.
4. Normal path: `bms_setup()` wires up the relay, restores fuel-gauge state,
   starts WiFi + web server.
5. `loop()` just pumps `TaskQueue.process()` — everything in the firmware runs
   as a one-shot or recurring task on a single cooperative queue
   (`lib/bms/task_queue_type.cpp`), no RTOS.

## The UART tap (`src/bms_main.cpp`)

- The ESP's hardware UART RX reads the BMS's white (A) line; TX drives the
  mainboard's white line at 115200 baud.
- The link is RS485-style differential. Owie only receives the A line, and
  **emulates the B line by bit-banging the inverse of its own TX**: TX is
  physically jumpered to GPIO4 (`TX_INPUT_PIN`), and rise/fall interrupts on
  that pin drive GPIO5 (`TX_INVERSE_OUT_PIN`) with the opposite level.
- **Locking is implemented in one place**: the relay's byte sink refuses to
  write to the mainboard while `Settings->is_locked` is set. The controller
  never hears from the BMS, so the board won't engage.

## Packet protocol (`lib/bms/packet.{h,cpp}`)

BMS packets look like:

```
FF 55 AA | type (1 byte) | payload | CRC16 (big-endian additive checksum)
```

Lengths are fixed per type (`PACKET_LENGTHS_BY_TYPE`). The checksum is a plain
16-bit sum of all preceding bytes. Known packet types:

| Type | Length | Content | Owie's treatment |
|---|---|---|---|
| 0 | 7 | Status bits: charging, empty, temp out of range, overcharged | **Dropped during normal riding** — forwarding it drives an Ah-tally loop in the controller that eventually throws Error 23. Forwarded only while charging/fault states are active |
| 2 | 38 | 15 cell voltages (mV, int16 BE) + 1 unknown value | Read for telemetry; min cell feeds the fuel gauge |
| 3 | 7 | Battery percentage (1 byte) | **Rewritten** with Owie's own SOC estimate (the key feature for expanded batteries). Dropped until the gauge has an estimate |
| 4 | 11 | 5 thermistor temps (°C, int8) | Read for telemetry |
| 5 | 8 | Battery current (int16 BE, 1 unit = 55 mA) | Feeds coulomb counting; **dropped unless charging** |
| 6 | 10 | BMS serial number (uint32 BE) | Captured, then **rewritten** with the spoofed serial — this defeats BMS↔controller pairing |
| 11 | 8 | Seen once at power-up | Passed through, never replayed |

## The relay pipeline (`lib/bms/bms_relay.cpp`)

`BmsRelay::loop()` drains the UART one byte at a time into a buffer:

1. **Framing**: bytes that don't match the `FF 55 AA` preamble, or that carry
   an unknown type byte, are flushed to the mainboard *unchanged* (Owie is
   transparent to anything it doesn't understand).
2. **Ingestion** (`ingestPacket`): the packet is handed to `PacketTracker`
   (stats), then to each type-specific parser. Parsers read telemetry into the
   relay's fields and may mutate the payload (`serial`, `SOC`) or mark the
   packet as not-to-forward (`status`, `current`).
3. **CRC recompute + forward**: since parsers may have rewritten bytes, the
   checksum is recalculated before the packet is written to the mainboard.
4. **Replay** (`maybeReplayPackets`): when the wire goes idle, any known
   packet type that hasn't been seen within its timeout (500 ms for
   status/current, 3 s for the rest) is re-ingested from its last valid copy
   and re-sent. This keeps the controller fed even when the BMS pauses.

`PacketTracker` (`lib/bms/packet_tracker.{h,cpp}`) keeps per-type counts,
inter-arrival mean/deviation (Welford's online algorithm, `welford.h`), the
last valid copy of each packet (used for replay), and global unknown-byte /
checksum-mismatch counters. All of it is rendered on the `/monitor` page.

## Battery fuel gauge (`lib/bms/battery_fuel_gauge.cc`)

The stock BMS reports nonsense percentages once the pack is modified, so Owie
computes its own SOC by fusing two signals:

- **Voltage-based SOC**: the minimum cell voltage is low-pass filtered
  (2nd-order Butterworth, ~400 s period, `filter.h`) and mapped through a
  Li-ion open-circuit-voltage lookup table (2.7–4.2 V → 0–100 %).
- **Coulomb counting**: each current packet integrates into
  milliamp-seconds discharged/recharged since the last update.

The gauge maintains a window — `topSoc`/`bottomSoc` (voltage-based estimates
at the highest charge and deepest discharge seen) and
`bottomMilliampSeconds` (the Ah span of that window) — and reports SOC by
linearly interpolating the current Ah position within it. Voltage-based
corrections drag the window endpoints when the Ah estimate drifts more than
3× off near the extremes (≤10 % or ≥90 % while charging). Gauge state is
serialized into settings (`BatteryStateMsg`) for restore across power cycles;
the save-on-power-off hook is currently commented out pending the NVS work.

## Settings persistence (`src/settings.cpp`)

Settings are a nanopb-encoded `SettingsMsg` protobuf written into a flash
sector via `EEPROM_Rotate`, which rotates writes across 4 sectors for wear
leveling (rotation is disabled right before an OTA flash). The blob is
prefixed with a 2-byte length. A decode failure resets to defaults.
`lib/nvs/` is the in-progress replacement: an append-style page format
(`nvs.proto`) with page headers (version/sequence/erase-count), named values,
and tombstones.

## Network & web UI (`src/network.cpp`)

- **WiFi**: always starts a SoftAP (`Owie-XXXX` from the chip ID, or a custom
  name/password), optionally also joins a home network in STA mode. A
  wildcard DNS server resolves every name to the ESP (captive-portal style),
  so connecting to the AP lands you on the status page.
- **Web server** (ESPAsyncWebServer): serves the pages from `data/`, which are
  embedded at build time — `pio_tools/gen_data.py` runs `html-minifier-terser`
  on each file and generates PROGMEM byte arrays plus `%PLACEHOLDER%`
  template substitution via `templateProcessor()`.
- Endpoints: `/` (status), `/battery` (fuel-gauge state + resets), `/wifi`,
  `/settings` (AP name/password/TX power), `/monitor` (packet stats),
  `/autoupdate` (JSON polled by the status page), `/rawdata` (WebSocket
  streaming every raw BMS packet for protocol reverse-engineering), `/lock`
  (arm/disarm/unlock), `/update` (OTA).
- **OTA** (`src/async_ota.cpp`): browser-upload flashing with optional MD5
  verification; also used by the `ota` PlatformIO env
  (`pio run -e ota -t upload`) which POSTs the firmware over HTTP.

## Build & test

- `pio run -e d1_mini_lite_clone` — firmware build (nanopb codegen from
  `proto/`, web assets inlined, linked for 1 MB flash Wemos D1 Mini Lite).
- `pio test -e native` — the `lib/bms/` core compiles for the host and is
  tested with Unity (fake `millis`, scripted packet streams).
- CI (`.github/workflows/`) runs both on every push; tagged `v*` pushes
  publish `firmware.bin` as a GitHub release.
