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
