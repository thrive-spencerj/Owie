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
