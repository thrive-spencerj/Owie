# Battery Profiles — Design Spec

Date: 2026-08-03
Status: Approved design, pending final capacity confirmation
Branch: `docs-and-build-fixes`

## Overview

Add a selectable **battery profile** to Owie so the firmware knows the pack's
nominal capacity and a human label. This unlocks two capacity-derived reports —
remaining "X of Y mAh" and State of Health — and lets a user identify their
pack. Profiles are chosen from a fixed, firmware-defined **preset list** (no
free-form entry). Settings stores only the selected preset id. The default
profile reproduces current behavior exactly.

Crucially, **this feature does not touch the SOC algorithm.** All Owie-compatible
packs share the same chemistry and 2.7–4.2 V range (see Compatibility), so
capacity is used only as a reporting reference; the gauge keeps computing and
self-learning SOC exactly as it does today.

## Compatibility (why the preset list is what it is)

Owie taps the Pint/XR BMS protocol, and its cell-voltage parser reads exactly
**15 series cells** (63 V full, 4.2 V/cell Li-ion). Only 15S / 63 V packs can
work with it. The presets are therefore limited to compatible packs:

| Preset | Config | Nominal capacity |
|---|---|---|
| Standard Li-ion (default) | — | unknown (0) |
| OneWheel Pint (stock) | 15S1P VTC6 | 3000 mAh |
| Quart | 15S1P 21700 | ~4000 mAh (spec 4.0–4.2 Ah) |
| OneWheel+ XR (stock) | 15S2P, 324 Wh NMC | ~6000 mAh (derived, confirm) |

Explicitly excluded as incompatible (different series count / voltage /
controller — mostly VESC-based, not the Pint/XR BMS): GT (18S2P), GT S-Series
(27S1P), X7 variants (20S/32S), Floatwheel Atom (22S1P). Pint X (15S2P, ~6800
mAh) is deferred pending confirmation that it speaks the Pint/XR BMS protocol.

## Goals

- Select a pack from a preset list on the battery page.
- Report **remaining "X of Y mAh"** and **State of Health** against the
  profile's nominal capacity.
- Default profile behaves exactly like today; existing boards self-migrate.

## Non-goals (YAGNI)

- Voltage-range / OCV parameterization — dropped: every compatible pack is
  2.7–4.2 V, so it would be inert while adding risk to the fuel-gauge WIP.
- Cycle counting and estimated range.
- Free-form / custom profile entry (presets only).
- Configurable series-cell count (all compatible packs are 15S).
- Any change to the SOC algorithm, the abandoned NVS work, or the 2 pre-existing
  fuel-gauge test failures (must not regress).

## Data model

A hardware-independent profile table, proposed at `lib/bms/battery_profile.h`:

```cpp
struct BatteryProfile {
  const char* label;
  int32_t capacityMah;  // nominal pack capacity; 0 = unknown (no capacity reports)
};

static const BatteryProfile BATTERY_PROFILES[] = {
  {"Standard Li-ion",       0},     // id 0 — default, == today's behavior
  {"OneWheel Pint (stock)", 3000},  // id 1
  {"Quart",                 4000},  // id 2  (spec 4.0-4.2 Ah; confirm)
  {"OneWheel+ XR (stock)",  6000},  // id 3  (derived from 324 Wh; confirm)
};
```

### Persistence

Add one field to `SettingsMsg` (proto3, next free tag is 13):

```proto
uint32 battery_profile_id = 13;
```

proto3 default 0 → existing saved settings load as "Standard Li-ion" with no
migration. `BatteryStateMsg` (the self-learned window) is unchanged. An
out-of-range stored id falls back to 0.

## Reporting (read-only; no algorithm change)

Two `const` getters added to `BatteryFuelGauge` that take the capacity and read
existing state (`getSoc()`, `getState()`), returning a sentinel when
unavailable. They do not modify any gauge state, so the SOC math and its tests
are untouched. Hidden in the UI when `capacityMah == 0`.

- **Remaining "X of Y mAh"**: `remaining = capacityMah * getSoc() / 100`,
  shown as `remaining of capacityMah mAh`. Guard: `getSoc() < 0` (not yet
  converged) → show `—`.

- **State of Health** — extrapolate the learned window to a full pack:
  - `learnedWindowMah = state.bottomMilliampSeconds / 3600`
  - `spanFraction = (state.topSoc - state.bottomSoc) / 100.0`
  - **Gate**: if `spanFraction < 0.40` or `bottomMilliampSeconds == 0`, return a
    "learning" sentinel (not enough observed range to extrapolate honestly).
  - else `fullUsableMah = learnedWindowMah / spanFraction`,
    `SoH% = clamp(fullUsableMah / capacityMah * 100, 0, 150)`.

  The 0.40 span threshold is a starting value, tunable after on-hardware
  observation.

## UI

**Battery page** (`data/battery.html`):

- A preset **dropdown** posted to `/battery` (alongside the existing
  `reset_stats` / `reset_settings` forms), via a new `%BATTERY_PROFILE_OPTIONS%`
  placeholder mirroring `%WIFI_POWER_OPTIONS%`.
- Two readouts in the key/value list: **Remaining** (`X of Y mAh`) and **State
  of health** (`N%` or `learning…`), shown only when the active profile has a
  nonzero capacity.

**Backend** (`src/network.cpp`):

- `templateProcessor` gains `BATTERY_PROFILE_OPTIONS`, `BATTERY_PROFILE_NAME`,
  `REMAINING_MAH`, `CAPACITY_MAH`, `STATE_OF_HEALTH`, resolving the active
  profile from `Settings->battery_profile_id`.
- The `/battery` POST handler gains a `battery_profile` branch: validate the id,
  store it, save settings, redirect. **No gauge reset is needed on profile
  change** — all profiles share the same voltage range, so switching only
  changes the capacity reference; the learned window stays valid and SoH /
  remaining simply recompute.

All new tokens obey the template-processor `%` rule (placeholders only, `%%`
for a literal percent); no stray `%` in `battery.html`.

## Testing

New native (`lib/bms`) unit tests, runnable via `pio test -e native`:

- SoH: below-threshold span returns the "learning" sentinel; above threshold
  extrapolates and divides by capacity correctly; `capacity == 0` yields no
  report.
- Remaining: `capacity * soc / 100` at representative SOC values; `soc < 0`
  yields the `—` sentinel.

## Risks & mitigations

- **SoH honesty** → the 0.40 span gate prevents a freshly-flashed board from
  showing an alarming low health number before it has cycled through a wide
  range.
- **Capacity accuracy** → values are user-supplied / derived; all capacity
  reports are only as good as those numbers. Quart is inherently a range
  (4.0–4.2 Ah); XR is derived from watt-hours.
- **Scope creep into the WIP gauge** → avoided entirely; the feature only adds
  read-only getters and never alters the SOC path.

## Open items

- Confirm **Quart** (~4000 mAh; spec range 4.0–4.2 Ah) and **XR** (~6000 mAh,
  derived from 324 Wh at ~54 V nominal — would be ~5850 at 55.5 V) capacities.
- Decide later whether to add **Pint X** once BMS-protocol compatibility is
  confirmed.
