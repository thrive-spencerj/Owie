# Power & Per-Cell Resistance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add instantaneous power (W), session energy (Wh used/regen), and per-cell internal resistance (mΩ), without touching the SOC algorithm.

**Architecture:** A new `PowerStats` module owns energy accumulation and per-cell resistance; it is fed from the existing `currentParser`/`cellVoltageParser`. Instantaneous power is a stateless reporting-layer calc.

**Tech Stack:** C++ (Arduino/ESP8266), PlatformIO, Unity (native tests), ESPAsyncWebServer template processor.

## Global Constraints

- Templated `data/*.html` must contain NO stray `%` — only `%PLACEHOLDER%` and `%%` for literal percent. Unknown `%TOKEN%` triggers `alert('UNKNOWN PLACEHOLDER')`. Prefer HTML entities (`&#37;` %, `&#8486;` Ω) in processor return strings; wrap returned literals in `PSTR(...)` to match the codebase.
- Do NOT modify `openCircuitSocFromCellVoltage`, `updateVoltage`, `updateCurrent`, or `BatteryFuelGauge`. The 2 pre-existing `test_battery_fuel_gauge` failures must not increase.
- Build: `pio run -e d1_mini_lite_clone`. Native tests: `pio test -e native`. New test only: `pio test -e native -f test_power_stats`.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## File Structure

- Create `lib/bms/power_stats.h` / `lib/bms/power_stats.cc` — the module.
- Create `test/test_power_stats/power_stats_test.cpp` — native tests.
- Modify `lib/bms/bms_relay.h` — own a `PowerStats`, expose a getter, feed it from the parsers.
- Modify `lib/bms/packet_parsers.cpp` — two feed calls.
- Modify `src/network.cpp` — `POWER_WATTS` + `CELL_RESISTANCE_ROWS` tokens, `reset_power` POST branch.
- Modify `data/index.html` — live power readout.
- Modify `data/battery.html` — power/resistance panel + reset button.

---

### Task 1: PowerStats module + tests

**Files:**
- Create: `lib/bms/power_stats.h`, `lib/bms/power_stats.cc`
- Create: `test/test_power_stats/power_stats_test.cpp`

**Interfaces:**
- Produces: `class PowerStats` with `updateCurrent(int32_t currentMa, int32_t packVoltageMv, int32_t nowMillis)`, `updateCells(const uint16_t* cellMv, int32_t currentMa)`, `getWattHoursUsed()`, `getWattHoursRegen()`, `getCellMilliohm(int)`, `getWeakestCell()`, `hasResistanceEstimate()`, `reset()`.

- [ ] **Step 1: Write the failing tests**

Create `test/test_power_stats/power_stats_test.cpp`:

```cpp
#include <unity.h>

#include "power_stats.h"

void setUp(void) {}
void tearDown(void) {}

void testEnergyIntegration() {
  PowerStats ps;
  ps.updateCurrent(1000, 50000, 0);         // seed (no accumulation on first call)
  ps.updateCurrent(1000, 50000, 3600000);   // 1h @ 50V, 1A discharge -> 50 Wh
  TEST_ASSERT_EQUAL_INT32(50, ps.getWattHoursUsed());
  TEST_ASSERT_EQUAL_INT32(0, ps.getWattHoursRegen());
  ps.updateCurrent(-1000, 50000, 7200000);  // 1h @ 50V, 1A regen -> 50 Wh
  TEST_ASSERT_EQUAL_INT32(50, ps.getWattHoursUsed());
  TEST_ASSERT_EQUAL_INT32(50, ps.getWattHoursRegen());
}

void testCellResistance() {
  PowerStats ps;
  uint16_t base[15];
  uint16_t load[15];
  for (int i = 0; i < 15; i++) { base[i] = 4000; load[i] = 4000; }
  load[3] = 3980;  // cell 3 sags 20 mV under a 1 A load -> 20 mOhm
  for (int n = 0; n < 6; n++) {
    ps.updateCells(base, 0);
    ps.updateCells(load, 1000);
  }
  TEST_ASSERT_EQUAL_INT32(20, ps.getCellMilliohm(3));
  TEST_ASSERT_EQUAL_INT32(0, ps.getCellMilliohm(0));
  TEST_ASSERT_EQUAL_INT(3, ps.getWeakestCell());
}

void testThresholdAndGate() {
  PowerStats ps;
  uint16_t base[15];
  uint16_t small[15];
  for (int i = 0; i < 15; i++) { base[i] = 4000; small[i] = 4000; }
  small[3] = 3999;
  ps.updateCells(base, 0);
  ps.updateCells(small, 100);  // dI = 100 mA < 500 threshold -> ignored
  TEST_ASSERT_EQUAL_INT32(-1, ps.getCellMilliohm(3));
  TEST_ASSERT_FALSE(ps.hasResistanceEstimate());

  uint16_t load[15];
  for (int i = 0; i < 15; i++) load[i] = 4000;
  load[3] = 3980;
  ps.reset();
  ps.updateCells(base, 0);
  for (int n = 0; n < 2; n++) { ps.updateCells(load, 1000); ps.updateCells(base, 0); }  // 4 transients
  TEST_ASSERT_EQUAL_INT32(-1, ps.getCellMilliohm(3));  // still < 5 samples
}

int main(int argc, char** argv) {
  UNITY_BEGIN();
  RUN_TEST(testEnergyIntegration);
  RUN_TEST(testCellResistance);
  RUN_TEST(testThresholdAndGate);
  return UNITY_END();
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pio test -e native -f test_power_stats`
Expected: FAIL to compile — `power_stats.h` not found.

- [ ] **Step 3: Create the header**

Create `lib/bms/power_stats.h`:

```cpp
#ifndef POWER_STATS_H
#define POWER_STATS_H

#include <stdint.h>

class PowerStats {
 public:
  static const int CELL_COUNT = 15;

  // currentMa signed (positive = discharge); packVoltageMv = total pack voltage.
  void updateCurrent(int32_t currentMa, int32_t packVoltageMv, int32_t nowMillis);
  void updateCells(const uint16_t* cellMv, int32_t currentMa);

  int32_t getWattHoursUsed() const;
  int32_t getWattHoursRegen() const;
  int32_t getCellMilliohm(int cell) const;  // -1 until estimated
  int getWeakestCell() const;               // highest-R cell index, or -1
  bool hasResistanceEstimate() const;

  void reset();

 private:
  int64_t used_mv_ma_ms_ = 0;
  int64_t regen_mv_ma_ms_ = 0;
  int32_t last_energy_millis_ = -1;

  int32_t prev_cell_mv_[CELL_COUNT] = {0};
  int32_t prev_current_ma_ = 0;
  bool have_prev_cells_ = false;
  float cell_milliohm_[CELL_COUNT] = {0};
  int32_t cell_samples_[CELL_COUNT] = {0};
};

#endif  // POWER_STATS_H
```

- [ ] **Step 4: Create the implementation**

Create `lib/bms/power_stats.cc`:

```cpp
#include "power_stats.h"

#include <stdlib.h>

namespace {
const int32_t RESISTANCE_MIN_DELTA_MA = 500;
const float RESISTANCE_EMA_ALPHA = 0.2f;
const int32_t RESISTANCE_MIN_SAMPLES = 5;
const float RESISTANCE_MAX_MILLIOHM = 500.0f;
const int64_t MV_MA_MS_PER_WH = 3600000000000LL;  // 1e3 * 1e3 * 1e3 * 3600
}  // namespace

void PowerStats::updateCurrent(int32_t currentMa, int32_t packVoltageMv,
                               int32_t nowMillis) {
  if (last_energy_millis_ < 0) {
    last_energy_millis_ = nowMillis;
    return;
  }
  const int32_t dt = nowMillis - last_energy_millis_;
  last_energy_millis_ = nowMillis;
  if (dt <= 0) {
    return;
  }
  const int64_t step = (int64_t)packVoltageMv * currentMa * dt;
  if (currentMa >= 0) {
    used_mv_ma_ms_ += step;
  } else {
    regen_mv_ma_ms_ -= step;  // step < 0 here, so regen grows positive
  }
}

void PowerStats::updateCells(const uint16_t* cellMv, int32_t currentMa) {
  if (have_prev_cells_) {
    const int32_t dI = currentMa - prev_current_ma_;
    if (abs(dI) >= RESISTANCE_MIN_DELTA_MA) {
      for (int i = 0; i < CELL_COUNT; i++) {
        const float r =
            -1000.0f * ((int32_t)cellMv[i] - prev_cell_mv_[i]) / (float)dI;
        if (r >= 0.0f && r <= RESISTANCE_MAX_MILLIOHM) {
          if (cell_samples_[i] == 0) {
            cell_milliohm_[i] = r;
          } else {
            cell_milliohm_[i] =
                cell_milliohm_[i] * (1.0f - RESISTANCE_EMA_ALPHA) +
                r * RESISTANCE_EMA_ALPHA;
          }
          cell_samples_[i]++;
        }
      }
    }
  }
  for (int i = 0; i < CELL_COUNT; i++) {
    prev_cell_mv_[i] = cellMv[i];
  }
  prev_current_ma_ = currentMa;
  have_prev_cells_ = true;
}

int32_t PowerStats::getWattHoursUsed() const {
  return (int32_t)(used_mv_ma_ms_ / MV_MA_MS_PER_WH);
}

int32_t PowerStats::getWattHoursRegen() const {
  return (int32_t)(regen_mv_ma_ms_ / MV_MA_MS_PER_WH);
}

int32_t PowerStats::getCellMilliohm(int cell) const {
  if (cell < 0 || cell >= CELL_COUNT ||
      cell_samples_[cell] < RESISTANCE_MIN_SAMPLES) {
    return -1;
  }
  return (int32_t)(cell_milliohm_[cell] + 0.5f);
}

int PowerStats::getWeakestCell() const {
  int worst = -1;
  int32_t worstR = -1;
  for (int i = 0; i < CELL_COUNT; i++) {
    const int32_t r = getCellMilliohm(i);
    if (r > worstR) {
      worstR = r;
      worst = i;
    }
  }
  return worst;
}

bool PowerStats::hasResistanceEstimate() const { return getWeakestCell() >= 0; }

void PowerStats::reset() {
  used_mv_ma_ms_ = 0;
  regen_mv_ma_ms_ = 0;
  last_energy_millis_ = -1;
  have_prev_cells_ = false;
  prev_current_ma_ = 0;
  for (int i = 0; i < CELL_COUNT; i++) {
    prev_cell_mv_[i] = 0;
    cell_milliohm_[i] = 0;
    cell_samples_[i] = 0;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pio test -e native -f test_power_stats`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/bms/power_stats.h lib/bms/power_stats.cc test/test_power_stats/power_stats_test.cpp
git commit -m "Add PowerStats: session energy and per-cell resistance

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire PowerStats into BmsRelay

**Files:**
- Modify: `lib/bms/bms_relay.h`
- Modify: `lib/bms/packet_parsers.cpp`

**Interfaces:**
- Consumes: `PowerStats` (Task 1); existing `current_milliamps_`, `total_voltage_millivolts_`, `cell_millivolts_`, `now_millis_`.
- Produces: `BmsRelay::getPowerStats()` returning `PowerStats&`.

- [ ] **Step 1: Add the member, include, and getter**

In `lib/bms/bms_relay.h`: add `#include "power_stats.h"` next to `#include "battery_fuel_gauge.h"`. Add a public getter near `getBatteryFuelGauge()`:

```cpp
  PowerStats& getPowerStats() { return power_stats_; }
```

And a private member near `BatteryFuelGauge battery_fuel_gauge_;`:

```cpp
  PowerStats power_stats_;
```

- [ ] **Step 2: Feed it from the parsers**

In `lib/bms/packet_parsers.cpp`, in `currentParser`, immediately after the existing `battery_fuel_gauge_.updateCurrent(current_milliamps_, now_millis_);` line, add:

```cpp
  power_stats_.updateCurrent(current_milliamps_, total_voltage_millivolts_,
                             now_millis_);
```

In `cellVoltageParser`, immediately after the existing `battery_fuel_gauge_.updateVoltage(min_voltage, now_millis_);` line, add:

```cpp
  power_stats_.updateCells(cell_millivolts_, current_milliamps_);
```

- [ ] **Step 3: Build firmware to verify wiring compiles**

Run: `pio run -e d1_mini_lite_clone`
Expected: SUCCESS.

- [ ] **Step 4: Confirm native suite unaffected**

Run: `pio test -e native`
Expected: `test_power_stats` PASS (3); only the 2 known `test_battery_fuel_gauge` failures remain.

- [ ] **Step 5: Commit**

```bash
git add lib/bms/bms_relay.h lib/bms/packet_parsers.cpp
git commit -m "Feed PowerStats from the current and cell-voltage parsers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Backend + UI

**Files:**
- Modify: `src/network.cpp`
- Modify: `data/index.html`
- Modify: `data/battery.html`

**Interfaces:**
- Consumes: `relay->getPowerStats()` (Task 2), `relay->getTotalVoltageMillivolts()`, `relay->getCurrentMilliamps()`.
- Produces: `%POWER_WATTS%`, `%CELL_RESISTANCE_ROWS%` template tokens; `reset_power` POST parameter on `/battery`.

- [ ] **Step 1: Add a helper builder**

In `src/network.cpp`, inside the anonymous namespace (near `batteryReportRows`), add:

```cpp
String cellResistanceRows() {
  PowerStats &ps = relay->getPowerStats();
  String out;
  out.reserve(512);
  out.concat(PSTR("<div class=\"kv\" style=\"margin-top:12px\">"));
  out.concat(PSTR("<div class=\"row\"><span class=\"kk\">Energy used</span>"
                  "<span class=\"vv\">"));
  out.concat(ps.getWattHoursUsed());
  out.concat(PSTR("<span class=\"unit\"> Wh</span></span></div>"));
  out.concat(PSTR("<div class=\"row\"><span class=\"kk\">Energy regenerated</span>"
                  "<span class=\"vv\">"));
  out.concat(ps.getWattHoursRegen());
  out.concat(PSTR("<span class=\"unit\"> Wh</span></span></div></div>"));

  if (!ps.hasResistanceEstimate()) {
    out.concat(PSTR("<p class=\"note\">Per-cell resistance: learning&hellip; "
                    "(ride to gather data)</p>"));
    return out;
  }
  const int weakest = ps.getWeakestCell();
  out.concat(PSTR("<h3 style=\"margin-top:16px\">Cell resistance (m&#8486;)</h3>"));
  out.concat(PSTR("<table class=\"grid-cells\">"));
  for (int r = 0; r < 3; r++) {
    out.concat(PSTR("<tr>"));
    for (int c = 0; c < 5; c++) {
      const int idx = r * 5 + c;
      const int32_t mo = ps.getCellMilliohm(idx);
      out.concat(idx == weakest ? PSTR("<td class=\"lo\">") : PSTR("<td>"));
      if (mo < 0) {
        out.concat(PSTR("&mdash;"));
      } else {
        out.concat(mo);
      }
      out.concat(PSTR("</td>"));
    }
    out.concat(PSTR("</tr>"));
  }
  out.concat(PSTR("</table>"));
  return out;
}
```

- [ ] **Step 2: Add the POWER_WATTS value to `/autoupdate`**

In `generateOwieStatusJson()`, add before `serializeJson`:

```cpp
  status["POWER_WATTS"] = String(relay->getTotalVoltageMillivolts() / 1000.0 *
                                     relay->getCurrentMilliamps() / 1000.0,
                                 0);
```

- [ ] **Step 3: Add template-processor cases**

In `templateProcessor`, add two `else if` branches (near the `BATTERY_REPORT_ROWS` branch):

```cpp
  } else if (var == "POWER_WATTS") {
    return String(relay->getTotalVoltageMillivolts() / 1000.0 *
                      relay->getCurrentMilliamps() / 1000.0,
                  0);
  } else if (var == "CELL_RESISTANCE_ROWS") {
    return cellResistanceRows();
```

- [ ] **Step 4: Add the `reset_power` POST branch**

In the `/battery` `HTTP_POST` case, add to the `if / else if` chain (before `request->redirect`):

```cpp
        } else if (request->getParam("reset_power", true) != nullptr) {
          relay->getPowerStats().reset();
```

- [ ] **Step 5: Add live power to the status page**

In `data/index.html`, inside `<div class="soc-charge" id="chargeState">`, after the `volts` div, add:

```html
                    <div class="power"><span id="POWER_WATTS">%POWER_WATTS%</span><span class="unit"> W</span></div>
```

- [ ] **Step 6: Add the power/resistance panel to the battery page**

In `data/battery.html`, add a new panel immediately after the "Battery pack" panel's closing `</div>` and before `<div class="actions">`:

```html
        <div class="panel">
            <h3>Power &amp; cell health</h3>
            %CELL_RESISTANCE_ROWS%
            <form method="post" style="margin-top:12px">
                <input type="hidden" name="reset_power">
                <button class="btn">Reset energy &amp; resistance</button>
            </form>
        </div>
```

- [ ] **Step 7: Audit for stray `%`**

Run:
```bash
for f in index battery; do
  python3 -c "import re; s=open('data/$f.html').read(); s=re.sub(r'%[A-Za-z_][A-Za-z0-9_]*%','',s); s=s.replace('%%',''); print('$f.html stray %:', s.count('%'))"
done
```
Expected: both `stray %: 0`.

- [ ] **Step 8: Build**

Run: `pio run -e d1_mini_lite_clone`
Expected: SUCCESS; note the flash %.

- [ ] **Step 9: Commit**

```bash
git add src/network.cpp data/index.html data/battery.html
git commit -m "Surface power, session energy and per-cell resistance in the UI

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Integration verification

- [ ] **Step 1: Full build** — `pio run -e d1_mini_lite_clone` → SUCCESS, note flash %.
- [ ] **Step 2: Full native suite** — `pio test -e native` → `test_power_stats` 3/3; only the 2 known `test_battery_fuel_gauge` failures remain.
- [ ] **Step 3: Stray-`%` sweep** — run the audit from Task 3 Step 7 across all templated pages (`index battery settings wifi dev_settings monitor update update_successful_response update_failed_template`); every line reports `0`.

Flashing to hardware is user-driven — do not flash.
