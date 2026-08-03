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
