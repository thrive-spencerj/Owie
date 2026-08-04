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
