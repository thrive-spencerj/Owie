# Battery Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user pick their pack from a preset list and show capacity-based reporting (remaining "X of Y mAh" and State of Health), without touching the SOC algorithm.

**Architecture:** A firmware-side preset table maps a stored `battery_profile_id` to `{label, capacityMah}`. Two read-only getters on `BatteryFuelGauge` derive remaining charge and State of Health from existing gauge state plus a capacity argument. The battery page gains a preset dropdown and (when capacity is known) the two readouts, rendered by `network.cpp`.

**Tech Stack:** C++ (Arduino/ESP8266), PlatformIO, nanopb (protobuf settings), Unity (native tests), ESPAsyncWebServer template processor.

## Global Constraints

- Templated pages (`data/battery.html` here) must contain **no stray `%`** — only `%PLACEHOLDER%` tokens and `%%` for a literal percent. An unknown `%TOKEN%` makes the processor inject `alert('UNKNOWN PLACEHOLDER')`. (Literal `%` inside a *processor return value* is safe — it is not re-scanned — but prefer the HTML entity `&#37;` there to be safe.)
- Default profile (id 0) must reproduce today's behavior exactly: `capacityMah = 0` → no capacity reports, no SOC change.
- Do not modify the SOC algorithm (`openCircuitSocFromCellVoltage`, `updateVoltage`, `updateCurrent`) or the abandoned NVS code. The 2 pre-existing `test_battery_fuel_gauge` failures must not increase.
- Build firmware with `pio run -e d1_mini_lite_clone`; run native tests with `pio test -e native`.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## File Structure

- Create `lib/bms/battery_profile.h` — preset table + lookup (hardware-independent, header-only).
- Modify `proto/settings.proto` — add `battery_profile_id` field.
- Modify `lib/bms/battery_fuel_gauge.h` / `.cc` — add two read-only reporting getters.
- Create `test/test_battery_profiles/battery_profiles_test.cpp` — native tests for the table and the getters.
- Modify `src/network.cpp` — profile-options + report-rows template cases, and the `/battery` POST branch.
- Modify `data/battery.html` — preset dropdown + report rows.

---

### Task 1: Preset table + settings field

**Files:**
- Create: `lib/bms/battery_profile.h`
- Modify: `proto/settings.proto`
- Create: `test/test_battery_profiles/battery_profiles_test.cpp`

**Interfaces:**
- Produces: `struct BatteryProfile { const char* label; int32_t capacityMah; };`, `const BatteryProfile BATTERY_PROFILES[]`, `const uint32_t BATTERY_PROFILE_COUNT`, `const BatteryProfile& getBatteryProfile(uint32_t id)` (out-of-range → id 0).
- Produces: `SettingsMsg.battery_profile_id` (uint32, proto tag 13, default 0).

- [ ] **Step 1: Write the failing test**

Create `test/test_battery_profiles/battery_profiles_test.cpp`:

```cpp
#include <unity.h>

#include "battery_profile.h"

void setUp(void) {}
void tearDown(void) {}

void testProfileTableValues() {
  TEST_ASSERT_EQUAL_UINT32(4, BATTERY_PROFILE_COUNT);
  TEST_ASSERT_EQUAL_INT32(0, getBatteryProfile(0).capacityMah);
  TEST_ASSERT_EQUAL_INT32(3000, getBatteryProfile(1).capacityMah);
  TEST_ASSERT_EQUAL_INT32(4200, getBatteryProfile(2).capacityMah);
  TEST_ASSERT_EQUAL_INT32(6000, getBatteryProfile(3).capacityMah);
}

void testProfileOutOfRangeFallsBackToDefault() {
  TEST_ASSERT_EQUAL_INT32(0, getBatteryProfile(99).capacityMah);
  TEST_ASSERT_EQUAL_STRING("Standard Li-ion", getBatteryProfile(99).label);
}

int main(int argc, char** argv) {
  UNITY_BEGIN();
  RUN_TEST(testProfileTableValues);
  RUN_TEST(testProfileOutOfRangeFallsBackToDefault);
  return UNITY_END();
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pio test -e native -f test_battery_profiles`
Expected: FAIL to compile — `battery_profile.h` not found / `getBatteryProfile` undefined.

- [ ] **Step 3: Create the profile header**

Create `lib/bms/battery_profile.h`:

```cpp
#ifndef BATTERY_PROFILE_H
#define BATTERY_PROFILE_H

#include <stdint.h>

struct BatteryProfile {
  const char* label;
  int32_t capacityMah;  // 0 = unknown (no capacity-based reporting)
};

// Preset profiles. The array index is the stored battery_profile_id.
// All entries are Owie-compatible 15S / 63 V / 4.2 V-cell Li-ion packs, so
// only capacity and label differ.
static const BatteryProfile BATTERY_PROFILES[] = {
    {"Standard Li-ion", 0},
    {"OneWheel Pint (stock)", 3000},
    {"Quart", 4200},
    {"OneWheel+ XR (stock)", 6000},
};

static const uint32_t BATTERY_PROFILE_COUNT =
    sizeof(BATTERY_PROFILES) / sizeof(BATTERY_PROFILES[0]);

// Returns the profile for id, or the default (id 0) if out of range.
inline const BatteryProfile& getBatteryProfile(uint32_t id) {
  if (id >= BATTERY_PROFILE_COUNT) {
    return BATTERY_PROFILES[0];
  }
  return BATTERY_PROFILES[id];
}

#endif  // BATTERY_PROFILE_H
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pio test -e native -f test_battery_profiles`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the settings field**

In `proto/settings.proto`, inside `message SettingsMsg`, add the new field just before the `reserved` line (tag 13 is free; 12 is `battery_state`):

```proto
  BatteryStateMsg battery_state = 12;
  uint32 battery_profile_id = 13;

  reserved 5,11;
```

- [ ] **Step 6: Verify the firmware build picks up the new field**

Run: `pio run -e d1_mini_lite_clone`
Expected: SUCCESS. (nanopb regenerates `settings.pb.h` with `battery_profile_id`; nothing references it yet.)

- [ ] **Step 7: Commit**

```bash
git add lib/bms/battery_profile.h proto/settings.proto test/test_battery_profiles/battery_profiles_test.cpp
git commit -m "Add battery preset table and settings field

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Reporting getters on BatteryFuelGauge

**Files:**
- Modify: `lib/bms/battery_fuel_gauge.h`
- Modify: `lib/bms/battery_fuel_gauge.cc`
- Modify: `test/test_battery_profiles/battery_profiles_test.cpp`

**Interfaces:**
- Consumes: existing `BatteryFuelGauge::getSoc() const`, `getState() const` (returns `FuelGaugeState` with `bottomMilliampSeconds`, `currentMilliampSeconds`, `topSoc`, `bottomSoc`), `restoreState(const FuelGaugeState&)`.
- Produces: `int32_t BatteryFuelGauge::getRemainingMah(int32_t capacityMah) const` (returns `-1` when capacity `<= 0` or `getSoc() < 0`). `int32_t BatteryFuelGauge::getStateOfHealthPercent(int32_t capacityMah) const` (returns `-2` when capacity `<= 0`, `-1` when not yet converged, else `0..150`).

- [ ] **Step 1: Write the failing tests**

Add these functions to `test/test_battery_profiles/battery_profiles_test.cpp` (above `main`), and add the `#include`:

```cpp
#include "battery_fuel_gauge.h"

static FuelGaugeState makeState(int32_t bottomMas, int32_t currentMas,
                                int32_t topSoc, int32_t bottomSoc) {
  FuelGaugeState s;
  s.bottomMilliampSeconds = bottomMas;
  s.currentMilliampSeconds = currentMas;
  s.topSoc = topSoc;
  s.bottomSoc = bottomSoc;
  return s;
}

void testRemainingMah() {
  BatteryFuelGauge g;
  // 1000 mAh window, discharged halfway -> SOC 50.
  g.restoreState(makeState(3600000, 1800000, 100, 0));
  TEST_ASSERT_EQUAL_INT32(3000, g.getRemainingMah(6000));  // 6000 * 50 / 100
  TEST_ASSERT_EQUAL_INT32(-1, g.getRemainingMah(0));       // capacity unknown
}

void testStateOfHealthConverged() {
  BatteryFuelGauge g;
  // Learned usable window = 1000 mAh across a full 0..100 span.
  g.restoreState(makeState(3600000, 0, 100, 0));
  TEST_ASSERT_EQUAL_INT32(100, g.getStateOfHealthPercent(1000));
  TEST_ASSERT_EQUAL_INT32(50, g.getStateOfHealthPercent(2000));
}

void testStateOfHealthLearning() {
  BatteryFuelGauge g;
  // Span too narrow (20 points) to extrapolate.
  g.restoreState(makeState(3600000, 0, 50, 30));
  TEST_ASSERT_EQUAL_INT32(-1, g.getStateOfHealthPercent(1000));
  // No learned window at all.
  g.restoreState(makeState(0, 0, 100, 0));
  TEST_ASSERT_EQUAL_INT32(-1, g.getStateOfHealthPercent(1000));
}

void testStateOfHealthUnknownCapacity() {
  BatteryFuelGauge g;
  g.restoreState(makeState(3600000, 0, 100, 0));
  TEST_ASSERT_EQUAL_INT32(-2, g.getStateOfHealthPercent(0));
}
```

Add their `RUN_TEST` lines inside `main`, before `return UNITY_END();`:

```cpp
  RUN_TEST(testRemainingMah);
  RUN_TEST(testStateOfHealthConverged);
  RUN_TEST(testStateOfHealthLearning);
  RUN_TEST(testStateOfHealthUnknownCapacity);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pio test -e native -f test_battery_profiles`
Expected: FAIL to compile — `getRemainingMah` / `getStateOfHealthPercent` not members of `BatteryFuelGauge`.

- [ ] **Step 3: Declare the getters**

In `lib/bms/battery_fuel_gauge.h`, in the `public:` section (e.g. right after `int32_t getVoltageBasedSoc() const { ... }`), add:

```cpp
  // Reporting helpers (read-only; do not affect SOC tracking).
  // Remaining charge in mAh for the given nominal capacity, or -1 if
  // unavailable (capacity unknown, or SOC not yet established).
  int32_t getRemainingMah(int32_t capacityMah) const;
  // State of health as a percentage for the given nominal capacity.
  // -2 if capacity is unknown (0); -1 if the gauge has not yet observed a
  // wide enough charge/discharge span to estimate honestly.
  int32_t getStateOfHealthPercent(int32_t capacityMah) const;
```

- [ ] **Step 4: Implement the getters**

In `lib/bms/battery_fuel_gauge.cc`, append at end of file:

```cpp
int32_t BatteryFuelGauge::getRemainingMah(int32_t capacityMah) const {
  if (capacityMah <= 0) {
    return -1;
  }
  const int32_t soc = getSoc();
  if (soc < 0) {
    return -1;
  }
  return capacityMah * soc / 100;
}

int32_t BatteryFuelGauge::getStateOfHealthPercent(int32_t capacityMah) const {
  if (capacityMah <= 0) {
    return -2;
  }
  const float spanFraction = (state_.topSoc - state_.bottomSoc) / 100.0f;
  if (state_.bottomMilliampSeconds <= 0 || spanFraction < 0.40f) {
    return -1;
  }
  const float learnedWindowMah = state_.bottomMilliampSeconds / 3600.0f;
  const float fullUsableMah = learnedWindowMah / spanFraction;
  int32_t soh = (int32_t)(fullUsableMah / capacityMah * 100.0f + 0.5f);
  if (soh < 0) soh = 0;
  if (soh > 150) soh = 150;
  return soh;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pio test -e native -f test_battery_profiles`
Expected: PASS (6 tests total in this file).

- [ ] **Step 6: Confirm no regression in the rest of the native suite**

Run: `pio test -e native`
Expected: `test_battery_profiles` PASS; `test_bms_relay`, `test_task_queue_type`, `test_packet_tracker` PASS; `test_battery_fuel_gauge` still 2 pre-existing failures (unchanged, not increased).

- [ ] **Step 7: Commit**

```bash
git add lib/bms/battery_fuel_gauge.h lib/bms/battery_fuel_gauge.cc test/test_battery_profiles/battery_profiles_test.cpp
git commit -m "Add remaining-mAh and state-of-health reporting getters

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Backend wiring in network.cpp

**Files:**
- Modify: `src/network.cpp`

**Interfaces:**
- Consumes: `BATTERY_PROFILES`, `BATTERY_PROFILE_COUNT`, `getBatteryProfile` (Task 1); `getRemainingMah`, `getStateOfHealthPercent` (Task 2); existing `Settings`, `relay`, `saveSettings()`.
- Produces: template tokens `%BATTERY_PROFILE_OPTIONS%` and `%BATTERY_REPORT_ROWS%`; a `battery_profile` POST parameter on `/battery`.

Note: the spec listed several individual tokens; this task bundles the readouts into a single `%BATTERY_REPORT_ROWS%` so the whole block can be hidden when capacity is unknown (returns `""`). This is a deliberate simplification (fewer tokens, satisfies the "shown only when nonzero capacity" requirement).

- [ ] **Step 1: Add the include**

In `src/network.cpp`, with the other `lib/bms` includes near the top (e.g. after `#include "bms_relay.h"`), add:

```cpp
#include "battery_profile.h"
```

- [ ] **Step 2: Add two helper builders**

In `src/network.cpp`, inside the anonymous `namespace { ... }` (near `renderPacketStatsTable`), add:

```cpp
String batteryProfileOptions() {
  String opts;
  opts.reserve(256);
  for (uint32_t i = 0; i < BATTERY_PROFILE_COUNT; i++) {
    opts.concat("<option value='");
    opts.concat(i);
    opts.concat("'");
    if (i == Settings->battery_profile_id) {
      opts.concat(" selected");
    }
    opts.concat(">");
    opts.concat(BATTERY_PROFILES[i].label);
    opts.concat("</option>");
  }
  return opts;
}

String batteryReportRows() {
  const BatteryProfile &prof = getBatteryProfile(Settings->battery_profile_id);
  if (prof.capacityMah <= 0) {
    return String("");
  }
  BatteryFuelGauge &gauge = relay->getBatteryFuelGauge();
  String out;
  out.reserve(384);
  out.concat("<div class=\"kv\" style=\"margin-top:12px\">");
  out.concat("<div class=\"row\"><span class=\"kk\">Capacity</span>"
             "<span class=\"vv\">");
  out.concat(prof.capacityMah);
  out.concat("<span class=\"unit\"> mAh</span></span></div>");

  out.concat("<div class=\"row\"><span class=\"kk\">Remaining</span>"
             "<span class=\"vv\">");
  const int32_t remaining = gauge.getRemainingMah(prof.capacityMah);
  if (remaining < 0) {
    out.concat("&mdash;");
  } else {
    out.concat(remaining);
    out.concat("<span class=\"unit\"> mAh</span>");
  }
  out.concat("</span></div>");

  out.concat("<div class=\"row\"><span class=\"kk\">State of health</span>"
             "<span class=\"vv\">");
  const int32_t soh = gauge.getStateOfHealthPercent(prof.capacityMah);
  if (soh == -1) {
    out.concat("learning&hellip;");
  } else if (soh < 0) {
    out.concat("&mdash;");
  } else {
    out.concat(soh);
    out.concat("<span class=\"unit\">&#37;</span>");  // &#37; == literal %
  }
  out.concat("</span></div>");

  out.concat("</div>");
  return out;
}
```

- [ ] **Step 3: Add the template-processor cases**

In `templateProcessor`, add two `else if` branches (e.g. right after the `PACKET_STATS_TABLE` branch):

```cpp
  } else if (var == "BATTERY_PROFILE_OPTIONS") {
    return batteryProfileOptions();
  } else if (var == "BATTERY_REPORT_ROWS") {
    return batteryReportRows();
```

- [ ] **Step 4: Handle the profile selection in the /battery POST**

In the `/battery` `HTTP_POST` case, add a branch to the existing `if / else if` chain (before `request->redirect("/battery");`):

```cpp
        } else if (request->getParam("battery_profile", true) != nullptr) {
          uint32_t id =
              request->getParam("battery_profile", true)->value().toInt();
          if (id < BATTERY_PROFILE_COUNT) {
            Settings->battery_profile_id = id;
            saveSettings();
          }
```

(No fuel-gauge reset: all presets share the same voltage range, so the learned window stays valid.)

- [ ] **Step 5: Build**

Run: `pio run -e d1_mini_lite_clone`
Expected: SUCCESS. (Tokens are defined but not yet referenced by any page — harmless.)

- [ ] **Step 6: Commit**

```bash
git add src/network.cpp
git commit -m "Wire battery profile selection and reporting into web backend

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Battery page UI

**Files:**
- Modify: `data/battery.html`

**Interfaces:**
- Consumes: `%BATTERY_PROFILE_OPTIONS%`, `%BATTERY_REPORT_ROWS%` (Task 3).

- [ ] **Step 1: Add the battery-pack panel**

In `data/battery.html`, add a new panel immediately after the closing `</div>` of the existing "Fuel gauge" panel and before `<div class="actions">`:

```html
        <div class="panel">
            <h3>Battery pack</h3>
            <form method="post">
                <label class="flabel" for="bp">Pack profile</label>
                <select id="bp" name="battery_profile" onchange="this.form.submit()">%BATTERY_PROFILE_OPTIONS%</select>
            </form>
            %BATTERY_REPORT_ROWS%
        </div>
```

- [ ] **Step 2: Audit for stray `%`**

Run:
```bash
python3 -c "import re; s=open('data/battery.html').read(); s=re.sub(r'%[A-Za-z_][A-Za-z0-9_]*%','',s); s=s.replace('%%',''); print('stray %:', s.count('%'))"
```
Expected: `stray %: 0`

- [ ] **Step 3: Build (verifies the page minifies and links)**

Run: `pio run -e d1_mini_lite_clone`
Expected: SUCCESS, with a line `Minified '.../data/battery.html' ...`.

- [ ] **Step 4: Visual check via a substituted preview**

Run (generates a preview with the placeholders filled, then inspect it in the browser at `file://.../data/_p_battery.html`):
```bash
python3 - <<'PY'
s=open('data/battery.html').read()
opts="<option value='0'>Standard Li-ion</option><option value='3' selected>OneWheel+ XR (stock)</option>"
rows=("<div class=\"kv\" style=\"margin-top:12px\">"
      "<div class=\"row\"><span class=\"kk\">Capacity</span><span class=\"vv\">6000<span class=\"unit\"> mAh</span></span></div>"
      "<div class=\"row\"><span class=\"kk\">Remaining</span><span class=\"vv\">3600<span class=\"unit\"> mAh</span></span></div>"
      "<div class=\"row\"><span class=\"kk\">State of health</span><span class=\"vv\">94<span class=\"unit\">&#37;</span></span></div>"
      "</div>")
subs={'DISPLAY_AP_NAME':'Owie-C024','OVERRIDDEN_SOC':'60','VOLTAGE_BASED_SOC':'58',
      'BOTTOM_SOC':'8','TOP_SOC':'96','BOTTOM_MILLIAMP_HOURS':'5200','CURRENT_MILLIAMP_HOURS':'1450',
      'BATTERY_PROFILE_OPTIONS':opts,'BATTERY_REPORT_ROWS':rows}
for k,v in subs.items(): s=s.replace('%'+k+'%',v)
s=s.replace('%%','%')
open('data/_p_battery.html','w').write(s)
print('wrote data/_p_battery.html')
PY
```
Expected: the battery page shows the "Battery pack" panel with a populated dropdown and Capacity / Remaining / State of health rows. Delete the preview afterward: `rm -f data/_p_battery.html`.

- [ ] **Step 5: Commit**

```bash
git add data/battery.html
git commit -m "Add battery profile picker and capacity readouts to battery page

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Integration verification

**Files:** none (verification only).

- [ ] **Step 1: Full firmware build**

Run: `pio run -e d1_mini_lite_clone`
Expected: SUCCESS; note the flash percentage (was ~38.8%).

- [ ] **Step 2: Full native test suite**

Run: `pio test -e native`
Expected: `test_battery_profiles` PASS (6); other suites unchanged; only the 2 known `test_battery_fuel_gauge` failures remain.

- [ ] **Step 3: Stray-`%` audit across all templated pages**

Run:
```bash
for f in index battery settings wifi dev_settings monitor update update_successful_response update_failed_template; do
  python3 -c "import re; s=open('data/$f.html').read(); s=re.sub(r'%[A-Za-z_][A-Za-z0-9_]*%','',s); s=s.replace('%%',''); print('$f.html stray %:', s.count('%'))"
done
```
Expected: every line reports `stray %: 0`.

- [ ] **Step 4: (Optional, user-driven) Flash to hardware**

Only if the user asks. The board's `upload_speed = 524288` times out on the CH340 clone; flash at 115200 via a temporary override, then restore `platformio.ini`:
```bash
cp platformio.ini /tmp/pio.ini.bak
sed -i '' 's/^upload_speed = 524288/upload_speed = 115200/' platformio.ini
pio run -e d1_mini_lite_clone -t upload --upload-port /dev/cu.usbserial-10
cp /tmp/pio.ini.bak platformio.ini
```
Then connect to the board's `Owie-XXXX` AP, open the battery page, and confirm the dropdown persists a selection across a reload and that Capacity/Remaining show for a non-default profile (State of health will read "learning…" until the pack has cycled through a wide SOC range).

---

## Notes for the implementer

- The reporting getters are pure reads of existing state — never call `updateVoltage`/`updateCurrent` or mutate `state_` from them.
- `getSoc()` can legitimately return 0 early; only a negative value means "unavailable" for the remaining readout.
- Keep the default profile (id 0, capacity 0) behaving exactly as before: with capacity 0, `batteryReportRows()` returns `""`, so the battery page shows only the dropdown and no readouts — identical to today plus a selector defaulting to "Standard Li-ion".
