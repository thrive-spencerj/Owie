#ifndef TELEMETRY_H
#define TELEMETRY_H

class BmsRelay;

// Registers a recurring task that POSTs battery snapshots to the collector
// configured in Settings whenever station WiFi is up. Safe to call once from
// bms_setup().
void setupTelemetry(BmsRelay* relay);

#endif  // TELEMETRY_H
