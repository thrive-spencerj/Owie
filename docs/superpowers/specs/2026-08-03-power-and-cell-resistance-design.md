# Power & Per-Cell Internal Resistance — Design Spec

Date: 2026-08-03
Status: Approved design
Branch: `cell-resistance-power` (based on `docs-and-build-fixes`)

## Overview

Derive three new telemetry values from data Owie already reads — instantaneous
power, session energy (Wh used / regen), and per-cell internal resistance —
without touching the SOC algorithm. A new `PowerStats` module owns the
stateful parts (energy accumulation, per-cell resistance); instantaneous power
is a stateless reporting-layer calculation.

## Goals

- Show instantaneous **power (W)** = pack voltage × current on the status page.
- Track **session Wh used / regen** (reset on power cycle and via a button).
- Estimate **per-cell internal resistance (mΩ)** and flag the weakest cell.

## Non-goals (YAGNI)

- No persistence of energy across power cycles (session-only trip meter).
- No pack-level-only resistance (per-cell is the whole point).
- No change to the SOC algorithm, the fuel gauge, or the 2 pre-existing
  `test_battery_fuel_gauge` failures.
- Speed/distance/range — not available on the BMS bus.

## Module: `lib/bms/power_stats.{h,cc}` (hardware-independent, native-testable)

```cpp
class PowerStats {
 public:
  static const int CELL_COUNT = 15;

  // Energy integration. currentMa signed (positive = discharge);
  // packVoltageMv = total pack voltage; nowMillis monotonic.
  void updateCurrent(int32_t currentMa, int32_t packVoltageMv, int32_t nowMillis);

  // Per-cell resistance. cellMv = CELL_COUNT cell voltages (mV); currentMa = pack current.
  void updateCells(const uint16_t* cellMv, int32_t currentMa);

  int32_t getWattHoursUsed() const;   // whole Wh
  int32_t getWattHoursRegen() const;  // whole Wh
  // Per-cell internal resistance in milliohms, or -1 if not yet estimated.
  int32_t getCellMilliohm(int cell) const;
  int getWeakestCell() const;         // index of highest-R cell, or -1
  bool hasResistanceEstimate() const;

  void reset();

 private:
  // Energy: accumulate raw mV*mA*ms in 64-bit; convert on read.
  //   Wh = rawMilliVoltMilliAmpMillis / 3.6e12
  int64_t used_mv_ma_ms_ = 0;
  int64_t regen_mv_ma_ms_ = 0;
  int32_t last_energy_millis_ = -1;

  // Per-cell resistance (exponential moving average).
  int32_t prev_cell_mv_[CELL_COUNT] = {0};
  int32_t prev_current_ma_ = 0;
  bool have_prev_cells_ = false;
  float cell_milliohm_[CELL_COUNT] = {0};
  int32_t cell_samples_[CELL_COUNT] = {0};
};
```

### Constants (tunable, defined in the .cc)

- `RESISTANCE_MIN_DELTA_MA = 500` — ignore current steps smaller than this (noise).
- `RESISTANCE_EMA_ALPHA = 0.2f` — smoothing factor.
- `RESISTANCE_MIN_SAMPLES = 5` — transients required before a cell reports a value.
- `RESISTANCE_MAX_MILLIOHM = 500` — reject implausible samples (bad reads).

### Energy math

`updateCurrent`: on the first call, record `nowMillis` and return. Thereafter
`dt = nowMillis - last_energy_millis_` (skip if `dt <= 0`); `step = (int64)packVoltageMv * currentMa * dt`. If `currentMa >= 0` add `step` to `used_mv_ma_ms_`, else subtract to `regen_mv_ma_ms_`. `getWattHoursUsed() = used_mv_ma_ms_ / 3600000000000LL`.

### Resistance math

`updateCells`: if `have_prev_cells_`, `dI = currentMa - prev_current_ma_`; if
`abs(dI) >= RESISTANCE_MIN_DELTA_MA`, then for each cell `i`:
`R_mOhm = -1000.0f * (cellMv[i] - prev_cell_mv_[i]) / dI` (negative because
voltage sags as discharge current rises). If `0 <= R_mOhm <= RESISTANCE_MAX_MILLIOHM`,
fold into the EMA (`cell_milliohm_[i]`) and increment `cell_samples_[i]`.
Always store `prev_cell_mv_`/`prev_current_ma_` and set `have_prev_cells_`.
`getCellMilliohm(i)` returns `-1` until `cell_samples_[i] >= RESISTANCE_MIN_SAMPLES`.

## Wiring (`lib/bms/bms_relay.{h,cc}`, `packet_parsers.cpp`)

- `BmsRelay` gains `PowerStats power_stats_;` and `PowerStats& getPowerStats()`.
- `currentParser` (after the existing fuel-gauge call):
  `power_stats_.updateCurrent(current_milliamps_, total_voltage_millivolts_, now_millis_);`
- `cellVoltageParser` (after computing cells + total):
  `power_stats_.updateCells(cell_millivolts_, current_milliamps_);`

`current_milliamps_` and `total_voltage_millivolts_` persist between packets, so
each parser uses the most recent value of the other — close enough (voltage and
current move slowly relative to packet cadence).

## UI

**Status page** (`data/index.html`, live via `/autoupdate`):
- Instantaneous **power (W)** added to the SOC card's charge box (a `POWER_WATTS`
  numeric value, unit in markup, following the bare-number convention).

**Battery page** (`data/battery.html`, templated):
- **Session energy** rows: Wh used, Wh regenerated.
- **Per-cell resistance grid** (mΩ) reusing `.grid-cells` styling; the weakest
  cell gets the `.lo`-style highlight. Before enough samples, cells show `—`.
- Backend builds these via new template tokens (single `%CELL_RESISTANCE_ROWS%`
  bundling grid + Wh, hidden/`learning` when `!hasResistanceEstimate()`), plus
  `%POWER_WATTS%` on the status side. All obey the template-processor `%` rule
  (placeholders only, `%%`/`&#37;` for literal percent, PSTR for returned literals).

**Reset**: the battery page's existing reset area gains a `reset_power` POST
branch calling `power_stats_.reset()`.

## Tests (`test/test_power_stats/`, native — keep it lean)

- `testEnergyIntegration`: feed `updateCurrent` a known V, I, dt sequence →
  assert `getWattHoursUsed` / `getWattHoursRegen`.
- `testCellResistance`: two `updateCells` calls with a current step and a known
  per-cell sag → assert `getCellMilliohm` and `getWeakestCell`.
- `testResistanceThresholdAndGate`: sub-threshold ΔI yields no estimate; fewer
  than `RESISTANCE_MIN_SAMPLES` transients → `getCellMilliohm` returns -1.

## Risk

- New module only; SOC/fuel-gauge code and tests untouched.
- Instantaneous power and session energy are exact. Per-cell resistance is
  approximate and only produces values once the board is installed on a pack
  and ridden through current transients — shows `—`/`learning` until then.
