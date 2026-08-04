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
