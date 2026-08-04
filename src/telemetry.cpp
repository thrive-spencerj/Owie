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
// in-flight request invariant. Writes to the socket always use
// ASYNC_WRITE_FLAG_COPY so lwIP copies the bytes instead of holding a
// pointer into this buffer, letting it be safely reused as soon as the
// next request is built.
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
  // Synchronously abort so lwIP drops any unsent/unacked segments that may
  // still reference requestBuf, since the deferred delete below leaves the
  // pcb alive (and able to retransmit from requestBuf) until it runs. A
  // no-op if the pcb is already gone (e.g. this ran from the error path).
  c->close(true);
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
  // Static: this is a recurring-task callback with a tight cont stack
  // budget, and the single in-flight invariant (the client != nullptr guard
  // above) guarantees only one maybePost() call builds a payload at a time.
  static char body[768];
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
  client->onConnect(
      [](void*, AsyncClient* c) {
        c->write(requestBuf, strlen(requestBuf), ASYNC_WRITE_FLAG_COPY);
      },
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
