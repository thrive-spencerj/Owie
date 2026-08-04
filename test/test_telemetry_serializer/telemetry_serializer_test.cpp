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

void setUp() {}
void tearDown() {}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_golden_json);
  RUN_TEST(test_negative_and_charging_values);
  RUN_TEST(test_buffer_too_small_returns_zero);
  return UNITY_END();
}
