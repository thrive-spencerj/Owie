#include <unity.h>

#include "battery_fuel_gauge.h"

void setUp(void) {}
void tearDown(void) {}

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
  // Span too narrow (20 points) to extrapolate honestly.
  g.restoreState(makeState(3600000, 0, 50, 30));
  TEST_ASSERT_EQUAL_INT32(-1, g.getStateOfHealthPercent(1000));
}

int main(int argc, char** argv) {
  UNITY_BEGIN();
  RUN_TEST(testRemainingMah);
  RUN_TEST(testStateOfHealthConverged);
  RUN_TEST(testStateOfHealthLearning);
  return UNITY_END();
}
