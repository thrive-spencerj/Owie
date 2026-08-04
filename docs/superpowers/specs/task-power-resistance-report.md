# Power & Per-Cell Resistance — Implementation Report

Branch: `cell-resistance-power`
Plan: `docs/superpowers/plans/2026-08-03-power-and-cell-resistance.md`

## Summary

All four tasks from the plan were executed in order, exactly as specified. No
deviations from the plan's code were needed. The SOC algorithm and
`BatteryFuelGauge` were not touched — only additive changes (new `PowerStats`
module, two feed calls, backend template glue, and UI markup).

## Task status and commits

| Task | Status | Commit |
|---|---|---|
| 1. PowerStats module + tests | DONE | `ad7832e` — "Add PowerStats: session energy and per-cell resistance" |
| 2. Wire PowerStats into BmsRelay | DONE | `4910e98` — "Feed PowerStats from the current and cell-voltage parsers" |
| 3. Backend + UI | DONE | `1f54b71` — "Surface power, session energy and per-cell resistance in the UI" |
| 4. Integration verification | DONE | (no code change; verification only, see below) |

All three commits carry the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Files touched

- Created: `lib/bms/power_stats.h`, `lib/bms/power_stats.cc`
- Created: `test/test_power_stats/power_stats_test.cpp`
- Modified: `lib/bms/bms_relay.h` (added `#include "power_stats.h"`, `PowerStats power_stats_` member, `getPowerStats()` getter)
- Modified: `lib/bms/packet_parsers.cpp` (feed calls in `currentParser` and `cellVoltageParser`)
- Modified: `src/network.cpp` (`cellResistanceRows()` helper, `POWER_WATTS` in `generateOwieStatusJson()`, `POWER_WATTS`/`CELL_RESISTANCE_ROWS` template-processor branches, `reset_power` POST branch on `/battery`)
- Modified: `data/index.html` (live `%POWER_WATTS%` readout in the charge-state block)
- Modified: `data/battery.html` (new "Power & cell health" panel with `%CELL_RESISTANCE_ROWS%` and a reset form)

## Build result

`pio run -e d1_mini_lite_clone` → **SUCCESS**

- Flash: 401003 / 1023984 bytes = **39.2%**
- RAM: 33584 / 81920 bytes = 41.0%

(Baseline before this feature, i.e. after Task 2's wiring, was 39.0% flash /
40.9% RAM; the UI/backend additions in Task 3 added ~1700 bytes of flash.)

## Native test suite

`pio test -e native` final run: **24 test cases: 2 failed, 22 succeeded**

- `test_power_stats`: **PASSED — 3/3** (`testEnergyIntegration`, `testCellResistance`, `testThresholdAndGate`)
- `test_bms_relay`: PASSED (10/10)
- `test_task_queue_type`: PASSED (2/2)
- `test_battery_profiles`: PASSED (3/3)
- `test_packet_tracker`: PASSED (2/2)
- `test_battery_fuel_gauge`: **FAILED — exactly the 2 pre-existing, known failures, no new ones:**
  - `testCurrentRideSpentAndRegeneratedStats` — `FAIL: Expected 123 Was 0`
  - `testSimpleChargeAndHalfwayDischarge` — `FAIL: Expected 3600000 Was 3599400`

This matches the documented WIP baseline exactly — failure count did not increase.

## Stray-`%` audit (Task 3 Step 7 / Task 4 Step 3)

Ran across all 9 templated pages:

```
index.html stray %: 0
battery.html stray %: 0
settings.html stray %: 0
wifi.html stray %: 0
dev_settings.html stray %: 0
monitor.html stray %: 0
update.html stray %: 0
update_successful_response.html stray %: 0
update_failed_template.html stray %: 0
```

All zero, as required.

## Deviations / concerns

- None from the plan's prescribed code. `#include "power_stats.h"` was added
  to `lib/bms/bms_relay.h` next to `battery_fuel_gauge.h` exactly as
  instructed; this transitively makes the `PowerStats` type visible in
  `src/network.cpp` without a separate include there.
- The new `<div class="power">…</div>` element added to `data/index.html`
  does not have a bespoke CSS rule of its own (it inherits default block
  styling within `.soc-charge`); the plan did not call for a CSS change here,
  and per the project's `/autoupdate` numeric contract the unit `<span>` is
  kept outside the `id`'d element so the generic `el.innerHTML = value` poll
  loop in `index.html` won't clobber it. No functional or template-safety
  issue, just a possible minor visual-polish follow-up if desired.
- Hardware was not flashed, per instructions.

## Constraints honored

- SOC algorithm (`openCircuitSocFromCellVoltage`, `updateVoltage`,
  `updateCurrent`) and `BatteryFuelGauge` were not modified — only two new
  `power_stats_.updateCurrent(...)` / `power_stats_.updateCells(...)` calls
  were added alongside the existing `battery_fuel_gauge_` calls.
- Branch `cell-resistance-power` was used throughout; no new branch was
  created.
