# Firmware Telemetry Push (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owie firmware POSTs v1-contract battery snapshots to the webapp's `/api/ingest` whenever the board is on station WiFi and telemetry is enabled in settings.

**Architecture:** A pure, natively-testable JSON serializer in `lib/telemetry/`; an Arduino-side module `src/telemetry.cpp` driven by the existing TaskQueue that gates on enabled/WiFi/cadence and fires one AsyncClient POST at a time; `telemetry_host`/`telemetry_enabled` settings with a settings-page section.

**Tech Stack:** ESP8266 Arduino (PlatformIO), ESPAsyncTCP (existing transitive dep), nanopb settings, Unity native tests.

**Spec:** `docs/superpowers/specs/2026-08-03-firmware-telemetry-push-design.md` — payload contract per `2026-08-03-owie-battery-telemetry-webapp-design.md` §1 (v1 fields only).

## Global Constraints

- Build firmware: `pio run -e d1_mini_lite_clone`. Native tests: `pio test -e native` (run one dir: `-f <test_dir>`). All commands from the repo root.
- Native baseline: `test_battery_fuel_gauge` has exactly **2 known pre-existing failures** (`Expected 123 Was 0`, `Expected 3600000 Was 3599400`). New tests must pass; the total failure count must not exceed 2.
- `data/settings.html` must pass the stray-`%` audit (expect `stray %: 0`): `python3 -c "import re; s=open('data/settings.html').read(); s=re.sub(r'%[A-Za-z_][A-Za-z0-9_]*%','',s); s=s.replace('%%',''); print('stray %:', s.count('%'))"`
- settings.proto: new fields are `string telemetry_host = 14` (`max_size:64` in settings.options — nanopb max_size includes the NUL, so 63 usable chars) and `bool telemetry_enabled = 15`. Fields 5 and 11 remain reserved.
- Telemetry constants: active = `current_ma > 500 || current_ma < -500 || charging`; 2000 ms active interval, 30000 ms idle, 5000 ms request timeout, default collector port 8020, path fixed `/api/ingest`.
- `chip_id` = full 32-bit `ESP.getChipId()` as lowercase hex, no padding, no prefix.
- Golden payload JSON (used by BOTH the native test in Task 1 and the webapp test in Task 4 — keep byte-identical):
  `{"chip_id":"c024","bms_serial":123456,"fw_version":"test-fw","uptime_s":60,"total_mv":58000,"current_ma":1000,"bms_soc":80,"overridden_soc":82,"voltage_soc":81,"cells_mv":[3866,3866,3866,3866,3866,3866,3866,3866,3866,3866,3866,3866,3866,3866,3866],"temps_c":[20,21,20,19,20],"charging":false,"status_byte":0,"used_mah":1000,"regen_mah":100}`

---

### Task 1: Telemetry JSON serializer (native-testable)

**Files:**
- Create: `lib/telemetry/telemetry_serializer.h`
- Create: `lib/telemetry/telemetry_serializer.cc`
- Test: `test/test_telemetry_serializer/telemetry_serializer_test.cpp`

**Interfaces:**
- Consumes: nothing (pure C++, no Arduino headers — it must compile in the `native` env).
- Produces: `struct TelemetrySnapshot` and `size_t buildTelemetryJson(char* out, size_t outSize, const TelemetrySnapshot& s)` (returns bytes written excluding NUL; 0 if the buffer is too small). Task 3 fills the struct from `BmsRelay` and posts the output.

- [ ] **Step 1: Write the failing test**

Mirror the Unity harness used by `test/test_power_stats/power_stats_test.cpp` (same setUp/tearDown/main scaffolding — read it first and copy its structure). Test body:

```cpp
#include <string.h>

#include <unity.h>

#include "telemetry_serializer.h"

namespace {
TelemetrySnapshot makeSnapshot() {
  TelemetrySnapshot s;
  s.chipId = 0xc024;
  s.bmsSerial = 123456;
  s.fwVersion = "test-fw";
  s.uptimeS = 60;
  s.totalMv = 58000;
  s.currentMa = 1000;
  s.bmsSoc = 80;
  s.overriddenSoc = 82;
  s.voltageSoc = 81;
  for (int i = 0; i < 15; i++) s.cellsMv[i] = 3866;
  const int8_t temps[5] = {20, 21, 20, 19, 20};
  for (int i = 0; i < 5; i++) s.tempsC[i] = temps[i];
  s.charging = false;
  s.statusByte = 0;
  s.usedMah = 1000;
  s.regenMah = 100;
  return s;
}
}  // namespace

void test_golden_json() {
  char buf[768];
  const TelemetrySnapshot s = makeSnapshot();
  const size_t n = buildTelemetryJson(buf, sizeof(buf), s);
  TEST_ASSERT_GREATER_THAN_UINT(0, n);
  TEST_ASSERT_EQUAL_UINT(strlen(buf), n);
  const char* expected =
      "{\"chip_id\":\"c024\",\"bms_serial\":123456,\"fw_version\":\"test-fw\","
      "\"uptime_s\":60,\"total_mv\":58000,\"current_ma\":1000,\"bms_soc\":80,"
      "\"overridden_soc\":82,\"voltage_soc\":81,\"cells_mv\":[3866,3866,3866,"
      "3866,3866,3866,3866,3866,3866,3866,3866,3866,3866,3866,3866],"
      "\"temps_c\":[20,21,20,19,20],\"charging\":false,\"status_byte\":0,"
      "\"used_mah\":1000,\"regen_mah\":100}";
  TEST_ASSERT_EQUAL_STRING(expected, buf);
}

void test_negative_and_charging_values() {
  char buf[768];
  TelemetrySnapshot s = makeSnapshot();
  s.currentMa = -3200;
  s.charging = true;
  s.statusByte = 0x20;
  s.tempsC[0] = -5;
  const size_t n = buildTelemetryJson(buf, sizeof(buf), s);
  TEST_ASSERT_GREATER_THAN_UINT(0, n);
  TEST_ASSERT_NOT_NULL(strstr(buf, "\"current_ma\":-3200"));
  TEST_ASSERT_NOT_NULL(strstr(buf, "\"charging\":true"));
  TEST_ASSERT_NOT_NULL(strstr(buf, "\"status_byte\":32"));
  TEST_ASSERT_NOT_NULL(strstr(buf, "\"temps_c\":[-5,"));
}

void test_buffer_too_small_returns_zero() {
  char buf[64];
  const TelemetrySnapshot s = makeSnapshot();
  TEST_ASSERT_EQUAL_UINT(0, buildTelemetryJson(buf, sizeof(buf), s));
}
```

Harness boilerplate (verify against `test/test_power_stats/power_stats_test.cpp` in case the project's convention differs — the existing convention wins):

```cpp
void setUp() {}
void tearDown() {}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_golden_json);
  RUN_TEST(test_negative_and_charging_values);
  RUN_TEST(test_buffer_too_small_returns_zero);
  return UNITY_END();
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pio test -e native -f test_telemetry_serializer`
Expected: FAIL to compile — `telemetry_serializer.h` not found.

- [ ] **Step 3: Implement the serializer**

`lib/telemetry/telemetry_serializer.h`:

```cpp
#ifndef TELEMETRY_SERIALIZER_H
#define TELEMETRY_SERIALIZER_H

#include <stddef.h>
#include <stdint.h>

// Every field of the webapp /api/ingest v1 payload. Plain data so this
// serializer stays Arduino-free and natively testable.
struct TelemetrySnapshot {
  uint32_t chipId;       // rendered as lowercase hex string
  uint32_t bmsSerial;
  const char* fwVersion; // compile-time constant; not escaped
  uint32_t uptimeS;
  uint16_t totalMv;
  int32_t currentMa;     // signed; positive = discharge
  int8_t bmsSoc;
  int8_t overriddenSoc;
  int8_t voltageSoc;
  uint16_t cellsMv[15];
  int8_t tempsC[5];
  bool charging;
  uint8_t statusByte;
  int32_t usedMah;
  int32_t regenMah;
};

// Writes the JSON payload into out. Returns bytes written (excluding the
// terminating NUL), or 0 if outSize is too small for the whole payload.
size_t buildTelemetryJson(char* out, size_t outSize, const TelemetrySnapshot& s);

#endif  // TELEMETRY_SERIALIZER_H
```

`lib/telemetry/telemetry_serializer.cc`:

```cpp
#include "telemetry_serializer.h"

#include <inttypes.h>
#include <stdarg.h>
#include <stdio.h>

namespace {
bool appendf(char* out, size_t outSize, size_t* pos, const char* fmt, ...) {
  va_list args;
  va_start(args, fmt);
  const int n = vsnprintf(out + *pos, outSize - *pos, fmt, args);
  va_end(args);
  if (n < 0 || static_cast<size_t>(n) >= outSize - *pos) {
    return false;
  }
  *pos += n;
  return true;
}
}  // namespace

size_t buildTelemetryJson(char* out, size_t outSize, const TelemetrySnapshot& s) {
  size_t pos = 0;
  if (!appendf(out, outSize, &pos,
               "{\"chip_id\":\"%" PRIx32 "\",\"bms_serial\":%" PRIu32
               ",\"fw_version\":\"%s\",\"uptime_s\":%" PRIu32
               ",\"total_mv\":%u,\"current_ma\":%" PRId32
               ",\"bms_soc\":%d,\"overridden_soc\":%d,\"voltage_soc\":%d"
               ",\"cells_mv\":[",
               s.chipId, s.bmsSerial, s.fwVersion, s.uptimeS,
               static_cast<unsigned>(s.totalMv), s.currentMa,
               static_cast<int>(s.bmsSoc), static_cast<int>(s.overriddenSoc),
               static_cast<int>(s.voltageSoc))) {
    return 0;
  }
  for (int i = 0; i < 15; i++) {
    if (!appendf(out, outSize, &pos, i ? ",%u" : "%u",
                 static_cast<unsigned>(s.cellsMv[i]))) {
      return 0;
    }
  }
  if (!appendf(out, outSize, &pos, "],\"temps_c\":[")) {
    return 0;
  }
  for (int i = 0; i < 5; i++) {
    if (!appendf(out, outSize, &pos, i ? ",%d" : "%d",
                 static_cast<int>(s.tempsC[i]))) {
      return 0;
    }
  }
  if (!appendf(out, outSize, &pos,
               "],\"charging\":%s,\"status_byte\":%u,\"used_mah\":%" PRId32
               ",\"regen_mah\":%" PRId32 "}",
               s.charging ? "true" : "false",
               static_cast<unsigned>(s.statusByte), s.usedMah, s.regenMah)) {
    return 0;
  }
  return pos;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pio test -e native -f test_telemetry_serializer`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the whole native suite and firmware build**

Run: `pio test -e native`
Expected: only the 2 known `test_battery_fuel_gauge` failures.
Run: `pio run -e d1_mini_lite_clone`
Expected: builds clean (the new lib compiles for the target too).

- [ ] **Step 6: Commit**

```bash
git add lib/telemetry test/test_telemetry_serializer
git commit -m "firmware: telemetry JSON serializer with native tests"
```

---

### Task 2: Telemetry settings (proto + settings page + POST handler)

**Files:**
- Modify: `proto/settings.proto` (add fields 14, 15)
- Modify: `proto/settings.options` (add `SettingsMsg.telemetry_host max_size:64`)
- Modify: `data/settings.html` (Telemetry section)
- Modify: `src/network.cpp` (templateProcessor placeholders + POST handling)

**Interfaces:**
- Consumes: existing settings machinery (`Settings`, `saveSettingsAndRestartSoon`).
- Produces: `Settings->telemetry_host` (char[64]) and `Settings->telemetry_enabled` (bool) — Task 3 reads both. Template placeholders `%TELEMETRY_HOST%` / `%TELEMETRY_ENABLED%`.

- [ ] **Step 1: Add the proto fields**

In `proto/settings.proto`, inside `SettingsMsg` after `battery_profile_id`:

```proto
  string telemetry_host = 14; // collector "host" or "host:port"; empty = unset
  bool telemetry_enabled = 15;
```

Append to `proto/settings.options`:

```
SettingsMsg.telemetry_host max_size:64
```

- [ ] **Step 2: Add the settings page section**

In `data/settings.html`, add inside the settings form, after the wifi power form group and before the form's submit control (match the page's existing form-group markup — read the surrounding lines first):

```html
      <div class="fgroup">
        <label class="flabel" for="telemetryhost">Telemetry collector (host or host:port)</label>
        <input type="text" id="telemetryhost" name="telemetryhost" value="%TELEMETRY_HOST%" maxlength="63" placeholder="192.168.1.50:8020">
      </div>
      <div class="fgroup">
        <label class="flabel" for="telemetryenabled">
          <input type="checkbox" id="telemetryenabled" name="telemetryenabled" value="1" %TELEMETRY_ENABLED%>
          Send battery telemetry to the collector
        </label>
      </div>
```

Run the stray-`%` audit from Global Constraints on `data/settings.html`. Expected: `stray %: 0`.

- [ ] **Step 3: Wire the template placeholders**

In `src/network.cpp` `templateProcessor`, add before the final `return "<script>..."` fallback:

```cpp
  } else if (var == "TELEMETRY_HOST") {
    return Settings->telemetry_host;
  } else if (var == "TELEMETRY_ENABLED") {
    return Settings->telemetry_enabled ? "checked" : "";
```

- [ ] **Step 4: Handle the POST**

In the `/settings` `HTTP_POST` branch of `src/network.cpp`, after the wifi power validation block and before `saveSettingsAndRestartSoon()` — reject-before-mutate, matching the handler's existing style:

```cpp
        const auto telemetryHost = request->getParam("telemetryhost", true);
        if (telemetryHost == nullptr ||
            telemetryHost->value().length() >=
                sizeof(Settings->telemetry_host)) {
          request->send(400, "text/html",
                        "Telemetry host must be under 64 characters.");
          return;
        }
```

and with the other assignments before the save:

```cpp
        snprintf(Settings->telemetry_host, sizeof(Settings->telemetry_host),
                 "%s", telemetryHost->value().c_str());
        Settings->telemetry_enabled =
            request->getParam("telemetryenabled", true) != nullptr;
```

- [ ] **Step 5: Verify build**

Run: `pio run -e d1_mini_lite_clone`
Expected: builds clean (nanopb regenerates settings from the proto; a failure mentioning `No module named 'google'` means the toolchain needs `pipx inject platformio protobuf` — see the owie-build skill).

- [ ] **Step 6: Commit**

```bash
git add proto/settings.proto proto/settings.options data/settings.html src/network.cpp
git commit -m "firmware: telemetry collector settings (proto + settings page)"
```

---

### Task 3: Telemetry module and wiring

**Files:**
- Create: `include/version.h`
- Create: `include/telemetry.h`
- Create: `src/telemetry.cpp`
- Modify: `src/network.cpp` (use OWIE_VERSION)
- Modify: `lib/bms/bms_relay.h` (add `getLastStatusByte()`)
- Modify: `src/bms_main.cpp` (call `setupTelemetry`)

**Interfaces:**
- Consumes: `buildTelemetryJson`/`TelemetrySnapshot` (Task 1), `Settings->telemetry_host`/`telemetry_enabled` (Task 2), `BmsRelay` getters, `TaskQueue.postRecurringTask` / `postOneShotTask`.
- Produces: `void setupTelemetry(BmsRelay* relay)`; `OWIE_VERSION` macro.

- [ ] **Step 1: Hoist the version constant**

`include/version.h`:

```cpp
#ifndef OWIE_VERSION_H
#define OWIE_VERSION_H

#define OWIE_VERSION "2.1.0-sj"

#endif  // OWIE_VERSION_H
```

In `src/network.cpp`: add `#include "version.h"` and change the local to
`const String owie_version = OWIE_VERSION;`.

- [ ] **Step 2: Expose the status byte**

In `lib/bms/bms_relay.h`, next to the other status accessors:

```cpp
  uint8_t getLastStatusByte() { return last_status_byte_; }
```

- [ ] **Step 3: The telemetry module**

`include/telemetry.h`:

```cpp
#ifndef TELEMETRY_H
#define TELEMETRY_H

class BmsRelay;

// Registers a recurring task that POSTs battery snapshots to the collector
// configured in Settings whenever station WiFi is up. Safe to call once from
// bms_setup().
void setupTelemetry(BmsRelay* relay);

#endif  // TELEMETRY_H
```

`src/telemetry.cpp`:

```cpp
#include "telemetry.h"

#include <ESP8266WiFi.h>
#include <ESPAsyncTCP.h>

#include <cstdlib>
#include <cstring>

#include "bms_relay.h"
#include "settings.h"
#include "task_queue.h"
#include "telemetry_serializer.h"
#include "version.h"

namespace {

const uint16_t DEFAULT_COLLECTOR_PORT = 8020;
const int32_t ACTIVE_CURRENT_MA = 500;
const uint32_t ACTIVE_INTERVAL_MS = 2000;
const uint32_t IDLE_INTERVAL_MS = 30000;
const uint32_t REQUEST_TIMEOUT_MS = 5000;

BmsRelay* relay = nullptr;
AsyncClient* client = nullptr;  // non-null while a request is in flight
uint32_t requestGeneration = 0;
uint32_t lastPostMillis = 0;
bool everPosted = false;
// Static request buffer: headers + serialized body. Guarded by the single
// in-flight request invariant.
char requestBuf[1024];

// Frees the in-flight client outside of its own callbacks (deleting an
// AsyncClient from inside its callback is unsafe).
void scheduleClientFree() {
  if (client == nullptr) {
    return;
  }
  AsyncClient* c = client;
  client = nullptr;
  c->onConnect(nullptr, nullptr);
  c->onDisconnect(nullptr, nullptr);
  c->onError(nullptr, nullptr);
  c->onData(nullptr, nullptr);
  TaskQueue.postOneShotTask([c]() { delete c; }, 0);
}

// Splits "host[:port]" from Settings into host + port.
bool parseCollector(char* host, size_t hostSize, uint16_t* port) {
  const char* setting = Settings->telemetry_host;
  const char* colon = strchr(setting, ':');
  const size_t hostLen =
      colon ? static_cast<size_t>(colon - setting) : strlen(setting);
  if (hostLen == 0 || hostLen >= hostSize) {
    return false;
  }
  memcpy(host, setting, hostLen);
  host[hostLen] = '\0';
  long p = DEFAULT_COLLECTOR_PORT;
  if (colon != nullptr) {
    p = strtol(colon + 1, nullptr, 10);
  }
  if (p <= 0 || p > 65535) {
    return false;
  }
  *port = static_cast<uint16_t>(p);
  return true;
}

void fillSnapshot(TelemetrySnapshot* s) {
  s->chipId = ESP.getChipId();
  s->bmsSerial = relay->getCapturedBMSSerial();
  s->fwVersion = OWIE_VERSION;
  s->uptimeS = millis() / 1000;
  s->totalMv = relay->getTotalVoltageMillivolts();
  s->currentMa = relay->getCurrentMilliamps();
  s->bmsSoc = relay->getBmsReportedSOC();
  s->overriddenSoc = relay->getOverriddenSOC();
  s->voltageSoc = relay->getBatteryFuelGauge().getVoltageBasedSoc();
  const uint16_t* cells = relay->getCellMillivolts();
  for (int i = 0; i < 15; i++) {
    s->cellsMv[i] = cells[i];
  }
  const int8_t* temps = relay->getTemperaturesCelsius();
  for (int i = 0; i < 5; i++) {
    s->tempsC[i] = temps[i];
  }
  s->charging = relay->isCharging();
  s->statusByte = relay->getLastStatusByte();
  s->usedMah = relay->getUsedChargeMah();
  s->regenMah = relay->getRegeneratedChargeMah();
}

void maybePost() {
  if (relay == nullptr || client != nullptr) {
    return;
  }
  if (!Settings->telemetry_enabled ||
      Settings->telemetry_host[0] == '\0') {
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }
  const int32_t ma = relay->getCurrentMilliamps();
  const bool active =
      ma > ACTIVE_CURRENT_MA || ma < -ACTIVE_CURRENT_MA || relay->isCharging();
  const uint32_t interval = active ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
  const uint32_t now = millis();
  if (everPosted && now - lastPostMillis < interval) {
    return;
  }

  TelemetrySnapshot snapshot;
  fillSnapshot(&snapshot);
  char body[768];
  const size_t bodyLen = buildTelemetryJson(body, sizeof(body), snapshot);
  if (bodyLen == 0) {
    return;
  }

  char host[64];
  uint16_t port;
  if (!parseCollector(host, sizeof(host), &port)) {
    return;
  }

  const int n = snprintf(requestBuf, sizeof(requestBuf),
                         "POST /api/ingest HTTP/1.1\r\n"
                         "Host: %s\r\n"
                         "Content-Type: application/json\r\n"
                         "Content-Length: %u\r\n"
                         "Connection: close\r\n\r\n%s",
                         host, static_cast<unsigned>(bodyLen), body);
  if (n < 0 || static_cast<size_t>(n) >= sizeof(requestBuf)) {
    return;
  }

  client = new AsyncClient();
  client->onConnect([](void*, AsyncClient* c) { c->write(requestBuf); },
                    nullptr);
  client->onDisconnect([](void*, AsyncClient*) { scheduleClientFree(); },
                       nullptr);
  client->onError([](void*, AsyncClient*, err_t) { scheduleClientFree(); },
                  nullptr);
  // Response is drained and ignored; fire-and-forget per spec.
  client->onData([](void*, AsyncClient*, void*, size_t) {}, nullptr);

  everPosted = true;
  lastPostMillis = now;
  const uint32_t generation = ++requestGeneration;
  if (!client->connect(host, port)) {
    scheduleClientFree();
    return;
  }
  // Belt-and-braces: free a stuck connection, but only for THIS request.
  TaskQueue.postOneShotTask(
      [generation]() {
        if (client != nullptr && generation == requestGeneration) {
          scheduleClientFree();
        }
      },
      REQUEST_TIMEOUT_MS);
}

}  // namespace

void setupTelemetry(BmsRelay* bmsRelay) {
  relay = bmsRelay;
  TaskQueue.postRecurringTask(maybePost);
}
```

- [ ] **Step 4: Hook into bms_setup**

In `src/bms_main.cpp`: add `#include "telemetry.h"` with the other includes, and after `setupWebServer(relay);` add:

```cpp
  setupTelemetry(relay);
```

- [ ] **Step 5: Verify**

Run: `pio run -e d1_mini_lite_clone`
Expected: builds clean.
Run: `pio test -e native`
Expected: only the 2 known `test_battery_fuel_gauge` failures.

- [ ] **Step 6: Commit**

```bash
git add include/version.h include/telemetry.h src/telemetry.cpp src/network.cpp lib/bms/bms_relay.h src/bms_main.cpp
git commit -m "firmware: telemetry push module posting to the collector"
```

---

### Task 4: Cross-stack contract test (webapp side)

**Files:**
- Test: `webapp/tests/firmware-contract.test.ts`

**Interfaces:**
- Consumes: the Golden payload JSON from Global Constraints (byte-identical to Task 1's native golden test), webapp `validatePayload`/`recordSample`.
- Produces: proof that what the firmware serializer emits is accepted by the webapp.

- [ ] **Step 1: Write the test**

`webapp/tests/firmware-contract.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { recordSample, validatePayload } from "../src/ingest";

// Byte-identical to the golden string asserted by the firmware's native
// serializer test (test/test_telemetry_serializer). If either side changes,
// both tests must change together.
const FIRMWARE_GOLDEN_JSON =
  '{"chip_id":"c024","bms_serial":123456,"fw_version":"test-fw",' +
  '"uptime_s":60,"total_mv":58000,"current_ma":1000,"bms_soc":80,' +
  '"overridden_soc":82,"voltage_soc":81,"cells_mv":[3866,3866,3866,3866,' +
  "3866,3866,3866,3866,3866,3866,3866,3866,3866,3866,3866]," +
  '"temps_c":[20,21,20,19,20],"charging":false,"status_byte":0,' +
  '"used_mah":1000,"regen_mah":100}';

describe("firmware serializer contract", () => {
  test("the firmware golden payload passes validation and records", () => {
    const body = JSON.parse(FIRMWARE_GOLDEN_JSON);
    const v = validatePayload(body);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const db = openDb(":memory:");
    const sample = recordSample(db, v.payload, 1000);
    expect(sample.id).toBeGreaterThan(0);
    const board = db
      .query("SELECT name FROM boards WHERE chip_id = 'c024'")
      .get() as any;
    expect(board.name).toBe("Owie-C024");
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd webapp && bun test tests/firmware-contract.test.ts`
Expected: PASS. (No RED step — this test guards an existing contract; it should pass immediately. If it fails, the serializer and webapp disagree and THAT is the bug to fix.)

Run: `cd webapp && bun test`
Expected: full suite passes (29 tests).

- [ ] **Step 3: Commit**

```bash
git add webapp/tests/firmware-contract.test.ts
git commit -m "webapp: firmware serializer contract test"
```
