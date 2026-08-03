# Battery Profiles — Design Spec

Date: 2026-08-03
Status: Approved design, pending capacity data
Branch: `docs-and-build-fixes`

## Overview

Add a selectable **battery profile** to Owie so the firmware knows the pack's
cell voltage range and nominal capacity. This makes voltage-based SOC correct
for non-standard packs (via voltage-range rescaling) and unlocks two
capacity-derived reports — remaining "X of Y mAh" and State of Health — while
keeping the default behavior byte-identical to today.

Profiles are chosen from a fixed, firmware-defined **preset list** (no free-form
custom entry). Settings stores only the selected preset id.

## Goals

- Let a user select their pack from a preset list on the battery page.
- Parameterize the fuel gauge's OCV lookup by the profile's per-cell min/max
  voltage (rescale the existing curve shape to that range).
- Report **remaining "X of Y mAh"** and **State of Health** against the
  profile's nominal capacity.
- Default profile reproduces current behavior exactly; existing boards
  self-migrate with no user action.

## Non-goals (YAGNI)

- Cycle counting and estimated range (explicitly dropped).
- Free-form / custom profile entry (presets only).
- Per-chemistry OCV *curve shapes* — we only rescale min/max, not reshape.
- Configurable series-cell count (all OneWheels are 15S; stays fixed).
- Changes to the abandoned NVS work or the 2 pre-existing fuel-gauge test
  failures (out of scope; must not regress further).

## Data model

A hardware-independent profile table, proposed at `lib/bms/battery_profile.h`
so native tests can cover it:

```cpp
struct BatteryProfile {
  const char* label;
  int32_t minCellMv;   // OCV table lower bound, per cell
  int32_t maxCellMv;   // OCV table upper bound, per cell
  int32_t capacityMah; // nominal pack capacity; 0 = unknown (no capacity reports)
};

static const BatteryProfile BATTERY_PROFILES[] = {
  {"Standard Li-ion",      2700, 4200, 0},          // id 0 — default, == today
  {"OneWheel XR (stock)",  2700, 4200, /* TBD */},  // id 1 — capacity from user
  {"OneWheel Pint (stock)",2700, 4200, /* TBD */},  // id 2 — capacity from user
};
```

Note: XR and Pint are the same chemistry as the default (2.7–4.2 V), so for the
initial list only `capacityMah` and `label` differ. The min/max mV mechanism is
built and wired for future expansion-pack presets but is identical across these
three. Id 0 has `capacityMah = 0`, meaning "unknown" — capacity reports are
hidden and behavior matches today exactly.

### Persistence

Add one field to `SettingsMsg` (proto3, next free tag is 13):

```proto
uint32 battery_profile_id = 13;
```

proto3 default is 0 → existing saved settings load as "Standard Li-ion" with no
migration step. `BatteryStateMsg` (the self-learned window) is unchanged.

## Fuel-gauge change (minimal, contained)

The only core-algorithm touch is in
`lib/bms/battery_fuel_gauge.cc: openCircuitSocFromCellVoltage`, which currently
hardcodes `LOOKUP_TABLE_RANGE_MIN_MV = 2700` / `MAX = 4200`. These become the
active profile's `minCellMv` / `maxCellMv`, plumbed through `BatteryFuelGauge`
as two members (`range_min_mv_`, `range_max_mv_`, defaulting to 2700 / 4200).
`updateVoltage` passes them into the (now-parameterized) OCV helper.

Capacity is **not** an input to the SOC algorithm. The gauge keeps building its
self-learned window (`bottomMilliampSeconds`, `topSoc`, `bottomSoc`) exactly as
now. Because the default profile equals the current constants, the SOC output
and the existing unit tests are unaffected.

## Reporting (capacity as reference only)

Computed in `BatteryFuelGauge` (where the state lives), surfaced via getters;
hidden entirely when `capacityMah == 0`.

- **Remaining "X of Y mAh"**: `remaining = capacityMah * getSoc() / 100`,
  displayed as `remaining of capacityMah mAh`. Guard: when `getSoc() < 0`
  (gauge not yet converged) show `—` rather than a negative number.

- **State of Health** — extrapolate the learned window to a full pack:
  - `learnedWindowMah = bottomMilliampSeconds / 3600`
  - `spanFraction = (topSoc - bottomSoc) / 100.0`
  - **Gate**: if `spanFraction < 0.40` or `bottomMilliampSeconds == 0`, report
    `learning` (not enough observed range to extrapolate honestly).
  - else `fullUsableMah = learnedWindowMah / spanFraction`,
    `SoH% = clamp(fullUsableMah / capacityMah * 100, 0, 150)`.

The 0.40 span threshold is a starting value, tunable after on-hardware
observation.

## UI

**Battery page** (`data/battery.html`, already redesigned):

- A preset **dropdown** posted to `/battery` (alongside the existing
  `reset_stats` / `reset_settings` forms), via a new
  `%BATTERY_PROFILE_OPTIONS%` placeholder mirroring `%WIFI_POWER_OPTIONS%`.
- Two readouts in the key/value list: **Remaining** (`X of Y mAh`) and
  **State of health** (`N%` or `learning…`), shown only when the active
  profile has a nonzero capacity.

**Backend** (`src/network.cpp`):

- `templateProcessor` gains `BATTERY_PROFILE_OPTIONS`, `BATTERY_PROFILE_NAME`,
  `REMAINING_MAH`, `CAPACITY_MAH`, `STATE_OF_HEALTH`, each resolving the active
  profile from `Settings->battery_profile_id`.
- The `/battery` POST handler gains a `battery_profile` branch: validate the id,
  store it, save settings, redirect. **Reset rule**: if the newly selected
  profile's voltage range differs from the previous one, call
  `getBatteryFuelGauge().reset()` (stale voltage anchor); if only capacity/label
  differ (XR↔Pint↔default), keep the learned state so SoH/remaining recompute
  against the new capacity.

All new tokens obey the template-processor `%` rule (placeholders only, `%%`
for a literal percent); no stray `%` in `battery.html`.

## Testing

New native (`lib/bms`) unit tests, runnable via `pio test -e native`:

- OCV rescale: same cell voltage maps to different SOC under a shifted
  min/max range; default range reproduces current values.
- SoH: below-threshold span returns "learning"; above threshold extrapolates
  and divides by capacity correctly; `capacity == 0` yields no report.
- Remaining: `capacity * soc / 100` at representative SOC values.

## Risks & mitigations

- **Touching WIP gauge code** → keep the default profile byte-identical to the
  current constants; add tests that pin default behavior. The 2 pre-existing
  failures remain out of scope and must not increase.
- **SoH honesty** → the span gate prevents a freshly-flashed board from showing
  an alarming low health number before it has cycled through a wide range.
- **Capacity accuracy** → values are user-supplied (see open item); all
  capacity reports are only as good as those numbers.

## Open item

- `capacityMah` for **OneWheel XR (stock)** and **OneWheel Pint (stock)** —
  to be supplied by the user before implementation. Both are assumed 2.7–4.2 V
  standard Li-ion; confirm alongside the capacities.
