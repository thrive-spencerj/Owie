# Battery Profiles Implementation — Report

Plan executed: `docs/superpowers/plans/2026-08-03-battery-profiles.md`
Branch: `docs-and-build-fixes` (no new branch/worktree created, as instructed)
Hardware flashing (Task 5 Step 4): skipped, per instructions — optional and user-driven.

## Task status

| Task | Status | Commit |
|---|---|---|
| 1: Preset table + settings field | Done | `eb8e190` |
| 2: Reporting getters on BatteryFuelGauge | Done | `f608aef` |
| 3: Backend wiring in network.cpp | Done | `dbbe2f6` |
| 4: Battery page UI | Done | `3d4c08b` |
| 5: Integration verification | Done | (verification only, no commit) |

Commit hashes (in order):
- `eb8e190` — Add battery preset table and settings field
- `f608aef` — Add remaining-mAh and state-of-health reporting getters
- `dbbe2f6` — Wire battery profile selection and reporting into web backend
- `3d4c08b` — Add battery profile picker and capacity readouts to battery page

All four commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` as required. Working tree is clean after the final commit; this report file itself was **not** committed (not requested by the plan).

## Build result (Task 5 Step 1)

`pio run -e d1_mini_lite_clone` → **SUCCESS**
- RAM: 41.4% (33,920 / 81,920 bytes)
- Flash: **38.9%** (398,735 / 1,023,984 bytes)

Note: the plan's Task 1 Step 3 baseline build (before any network.cpp/HTML changes) measured 38.8% flash; the final full-feature build is 38.9% — a ~1.5 KB increase from the new profile table, getters, template branches, and HTML panel, all expected for the feature added.

## Native test result (Task 5 Step 2)

`pio test -e native` → 21 test cases, 19 succeeded, 2 failed (all pre-existing, unrelated to this change):

- `test_bms_relay` — PASSED (10/10)
- `test_task_queue_type` — PASSED (2/2)
- `test_battery_profiles` — **PASSED (3/3)** — `testRemainingMah`, `testStateOfHealthConverged`, `testStateOfHealthLearning`
- `test_battery_fuel_gauge` — FAILED (2 of 4): `testCurrentRideSpentAndRegeneratedStats` (expected 123, got 0) and `testSimpleChargeAndHalfwayDischarge` (expected 3600000, got 3599400) — both are the pre-existing, known WIP failures called out in the task instructions; count did not increase.
- `test_packet_tracker` — PASSED (2/2)

TDD check for Task 2: confirmed the new test failed to compile (missing `getRemainingMah`/`getStateOfHealthPercent`) before the getters were added, then passed 3/3 after implementation — red/green cycle followed as specified.

## Stray-`%` audit (Task 4 Step 2 and Task 5 Step 3)

`data/battery.html` alone: `stray %: 0` (checked immediately after adding the panel, before the build).

Full sweep across all templated pages (Task 5 Step 3):
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
All report 0, as required by the Global Constraints.

## Task 4 Step 4 — visual check (deferred)

No browser is available in this environment. Instead, generated the substituted preview per the plan's script at `data/_p_battery.html`, then verified via grep:
- The "Battery pack" panel rendered with the populated `<select>` dropdown (profile options substituted) and Capacity / Remaining / **State of health** rows present with the expected substituted values (6000 mAh / 3600 mAh / 94%).
- No leftover `%TOKEN%` placeholders remained; the only `%` characters left in the rendered file were the intentional literal-percent units from the pre-existing SOC rows (`%%` → `%`) and the new SoH row's `&#37;` entity, matching expectations.
- Deleted `data/_p_battery.html` afterward as instructed (confirmed via `git status` — not tracked/staged).

**Visual confirmation in an actual browser is deferred to the human**, since this environment cannot render/screenshot pages.

## SOC-algorithm / default-behavior constraints

- `openCircuitSocFromCellVoltage`, `updateVoltage`, `updateCurrent` were **not modified** — only the two new read-only getters (`getRemainingMah`, `getStateOfHealthPercent`) were appended to `battery_fuel_gauge.cc`, and only declared (not defined) in the header change.
- Default profile (id 0, capacity 0): `getBatteryProfile(0)` returns `{"Standard Li-ion", 0}`; `batteryReportRows()` returns `""` when `capacityMah <= 0`, so the battery page shows only the dropdown (defaulted to "Standard Li-ion") with no capacity readouts — behavior identical to today except for the added (harmless, empty-when-unselected-nonzero) selector.

## Extra verification (beyond the plan, done after advisor review)

Two of the codebase's own documented UI footguns (from `owie-ui-constraints.md`) were checked against this change since they weren't explicitly in the plan's verification steps:

- **`owie-status` scoping**: confirmed it is a pure CSS-scoping class (`body.owie-status`, `.owie-status .kv .row`, etc., in `data/styles.css`) with no associated JavaScript in `battery.html` (no `<script>` tag at all) and no positional DOM selectors anywhere in `data/` that touch `.row`/`.vv`. The only `querySelectorAll` in any data page is in `index.html`, targeting `#CELL_VOLTAGE_TABLE td` — unrelated. The three new rows added to the battery page carry no positional-index risk.
- **`.flabel` CSS class**: confirmed it exists (`data/styles.css:500`), so the new `<label class="flabel">` renders styled, not bare.
- **Settings buffer headroom**: `MAX_SETTINGS_SIZE = SPI_FLASH_SEC_SIZE - 5` (~4091 bytes); the new `uint32 battery_profile_id` field adds at most 5 varint-encoded bytes to a message that is a small fraction of that budget — no overflow risk, and `pb_encode`/`saveSettings()` fail safely (return -1) rather than corrupt memory in any case.

## Deviations from the plan (all cosmetic/non-functional)

1. **Include placement**: the plan said to add `#include "battery_profile.h"` "after `#include "bms_relay.h"`"; it was instead placed *before* `bms_relay.h`, preserving the file's existing alphabetical include ordering (`async_ota.h`, `battery_profile.h`, `bms_relay.h`, `data.h`, `settings.h`, `task_queue.h`). Purely cosmetic — no functional difference.
2. **Flash percentage**: plan's expected baseline was "~38.8%" (matched exactly after Task 1); final full-feature build is **38.9%** (398,735 bytes), a small expected increase from the added code/HTML.
3. **RAM usage**: rose from 40.7% to 41.4% (33,380 → 33,920 bytes). Root cause: the new `batteryProfileOptions()`/`batteryReportRows()` helpers use plain C-string literals (e.g. `"<option value='"`) rather than `PSTR(...)`-wrapped literals like the neighboring `renderPacketStatsTable()` does, so those literals live in RAM instead of flash/PROGMEM. This is the plan's code verbatim (not something I altered), so it was implemented as specified — flagging it here as a possible future optimization, not a defect.

## Concerns

None blocking. The two items above (include ordering, PSTR-wrapping) are minor and match the plan as written; no changes were made beyond what the plan specified. The two pre-existing `test_battery_fuel_gauge` failures are unrelated WIP issues per the task's own baseline notes and were not touched.
