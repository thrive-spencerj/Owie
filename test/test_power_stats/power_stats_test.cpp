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
