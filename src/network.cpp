#include "network.h"

#include <DNSServer.h>
#include <ESP8266WiFi.h>
#include <ESPAsyncWebServer.h>

#include <functional>

#include "ArduinoJson.h"
#include "async_ota.h"
#include "battery_profile.h"
#include "bms_relay.h"
#include "data.h"
#include "settings.h"
#include "task_queue.h"

namespace {
DNSServer dnsServer;
AsyncWebServer webServer(80);
AsyncWebSocket ws("/rawdata");

const String defaultPass("****");
BmsRelay *relay;

const String owie_version = "2.1.0-sj";

String renderPacketStatsTable() {
  String result(
      PSTR("<table><tr><th>ID</th><th>Period</th><th>Deviation</th><th>Count</"
           "th></tr>"));
  for (const IndividualPacketStat &stat :
       relay->getPacketTracker().getIndividualPacketStats()) {
    if (stat.id < 0) {
      continue;
    }
    result.concat(PSTR("<tr><td>"));

    char buffer[16];
    snprintf_P(buffer, sizeof(buffer), PSTR("%X"), stat.id);
    result.concat(buffer);

    result.concat(PSTR("</td><td>"));
    result.concat(stat.mean_period_millis());
    result.concat(PSTR("</td><td>"));
    result.concat(stat.deviation_millis());
    result.concat(PSTR("</td><td>"));
    result.concat(stat.total_num);
    result.concat(PSTR("</td></tr>"));
  }

  result.concat(PSTR(
      "<tr><th>Unknown Bytes</th><th>Checksum Mismatches</th></tr><tr><td>"));
  result.concat(
      relay->getPacketTracker().getGlobalStats().total_unknown_bytes_received);
  result.concat(PSTR("</td><td>"));
  result.concat(relay->getPacketTracker()
                    .getGlobalStats()
                    .total_packet_checksum_mismatches);
  result.concat(PSTR("</td></tr></table>"));
  return result;
}

String batteryProfileOptions() {
  String opts;
  opts.reserve(256);
  for (uint32_t i = 0; i < BATTERY_PROFILE_COUNT; i++) {
    opts.concat(PSTR("<option value='"));
    opts.concat(i);
    opts.concat('\'');
    if (i == Settings->battery_profile_id) {
      opts.concat(PSTR(" selected"));
    }
    opts.concat('>');
    opts.concat(BATTERY_PROFILES[i].label);
    opts.concat(PSTR("</option>"));
  }
  return opts;
}

String batteryReportRows() {
  const BatteryProfile &prof = getBatteryProfile(Settings->battery_profile_id);
  if (prof.capacityMah <= 0) {
    return String("");
  }
  BatteryFuelGauge &gauge = relay->getBatteryFuelGauge();
  String out;
  out.reserve(384);
  out.concat(PSTR("<div class=\"kv\" style=\"margin-top:12px\">"));
  out.concat(PSTR("<div class=\"row\"><span class=\"kk\">Capacity</span>"
                  "<span class=\"vv\">"));
  out.concat(prof.capacityMah);
  out.concat(PSTR("<span class=\"unit\"> mAh</span></span></div>"));

  out.concat(PSTR("<div class=\"row\"><span class=\"kk\">Remaining</span>"
                  "<span class=\"vv\">"));
  const int32_t remaining = gauge.getRemainingMah(prof.capacityMah);
  if (remaining < 0) {
    out.concat(PSTR("&mdash;"));
  } else {
    out.concat(remaining);
    out.concat(PSTR("<span class=\"unit\"> mAh</span>"));
  }
  out.concat(PSTR("</span></div>"));

  out.concat(PSTR("<div class=\"row\"><span class=\"kk\">State of health</span>"
                  "<span class=\"vv\">"));
  const int32_t soh = gauge.getStateOfHealthPercent(prof.capacityMah);
  if (soh == -1) {
    out.concat(PSTR("learning&hellip;"));
  } else if (soh < 0) {
    out.concat(PSTR("&mdash;"));
  } else {
    out.concat(soh);
    out.concat(PSTR("<span class=\"unit\">&#37;</span>"));  // &#37; == literal %
  }
  out.concat(PSTR("</span></div>"));

  out.concat(PSTR("</div>"));
  return out;
}

String cellResistanceRows() {
  PowerStats &ps = relay->getPowerStats();
  String out;
  out.reserve(512);
  out.concat(PSTR("<div class=\"kv\" style=\"margin-top:12px\">"));
  out.concat(PSTR("<div class=\"row\"><span class=\"kk\">Energy used</span>"
                  "<span class=\"vv\">"));
  out.concat(ps.getWattHoursUsed());
  out.concat(PSTR("<span class=\"unit\"> Wh</span></span></div>"));
  out.concat(PSTR("<div class=\"row\"><span class=\"kk\">Energy regenerated</span>"
                  "<span class=\"vv\">"));
  out.concat(ps.getWattHoursRegen());
  out.concat(PSTR("<span class=\"unit\"> Wh</span></span></div></div>"));

  if (!ps.hasResistanceEstimate()) {
    out.concat(PSTR("<p class=\"note\">Per-cell resistance: learning&hellip; "
                    "(ride to gather data)</p>"));
    return out;
  }
  const int weakest = ps.getWeakestCell();
  out.concat(PSTR("<h3 style=\"margin-top:16px\">Cell resistance (m&#8486;)</h3>"));
  out.concat(PSTR("<table class=\"grid-cells\">"));
  for (int r = 0; r < 3; r++) {
    out.concat(PSTR("<tr>"));
    for (int c = 0; c < 5; c++) {
      const int idx = r * 5 + c;
      const int32_t mo = ps.getCellMilliohm(idx);
      out.concat(idx == weakest ? PSTR("<td class=\"lo\">") : PSTR("<td>"));
      if (mo < 0) {
        out.concat(PSTR("&mdash;"));
      } else {
        out.concat(mo);
      }
      out.concat(PSTR("</td>"));
    }
    out.concat(PSTR("</tr>"));
  }
  out.concat(PSTR("</table>"));
  return out;
}

String uptimeString() {
  const unsigned long nowSecs = millis() / 1000;
  const int hrs = nowSecs / 3600;
  const int mins = (nowSecs % 3600) / 60;
  const int secs = nowSecs % 60;
  String ret;
  if (hrs) {
    ret.concat(hrs);
    ret.concat('h');
  }
  ret.concat(mins);
  ret.concat('m');
  ret.concat(secs);
  ret.concat('s');
  return ret;
}

String getTempString() {
  const int8_t *thermTemps = relay->getTemperaturesCelsius();
  String temps;
  temps.reserve(256);
  temps.concat("<tr>");
  for (int i = 0; i < 5; i++) {
    // BMS reports Celsius; display in Fahrenheit.
    const int fahrenheit = thermTemps[i] * 9 / 5 + 32;
    temps.concat("<td>");
    temps.concat(fahrenheit);
    temps.concat("</td>");
  }
  temps.concat("<tr>");
  return temps;
}

String generateOwieStatusJson() {
  DynamicJsonDocument status(1024);
  String jsonOutput;
  const uint16_t *cellMillivolts = relay->getCellMillivolts();
  String out;
  out.reserve(256);
  for (int i = 0; i < 3; i++) {
    out.concat("<tr>");
    for (int j = 0; j < 5; j++) {
      out.concat("<td>");
      out.concat(cellMillivolts[i * 5 + j] / 1000.0);
      out.concat("</td>");
    }
    out.concat("<tr>");
  }

  // Values are sent as bare numbers (no unit suffix) so the client owns
  // formatting. This matches what templateProcessor() emits for the same
  // keys; units live in the page markup, outside the updated elements.
  status["TOTAL_VOLTAGE"] =
      String(relay->getTotalVoltageMillivolts() / 1000.0, 2);
  status["CURRENT_AMPS"] = String(relay->getCurrentMilliamps() / 1000.0, 1);
  status["BMS_SOC"] = String(relay->getBmsReportedSOC());
  status["OVERRIDDEN_SOC"] = String(relay->getOverriddenSOC());
  status["USED_CHARGE_MAH"] = String(relay->getUsedChargeMah());
  status["REGENERATED_CHARGE_MAH"] = String(relay->getRegeneratedChargeMah());
  status["UPTIME"] = uptimeString();
  status["CELL_VOLTAGE_TABLE"] = out;
  status["TEMPERATURE_TABLE"] = getTempString();
  status["POWER_WATTS"] = String(relay->getTotalVoltageMillivolts() / 1000.0 *
                                     relay->getCurrentMilliamps() / 1000.0,
                                 0);

  serializeJson(status, jsonOutput);
  return jsonOutput;
}

bool lockingPreconditionsMet() {
  return strlen(Settings->ap_self_password) > 0;
}
const char *lockedStatusDataAttrValue() {
  return Settings->is_locked ? "1" : "";
};

String templateProcessor(const String &var) {
  if (var == "TOTAL_VOLTAGE") {
    return String(relay->getTotalVoltageMillivolts() / 1000.0,
                  /* decimalPlaces = */ 2);
  } else if (var == "CURRENT_AMPS") {
    return String(relay->getCurrentMilliamps() / 1000.0,
                  /* decimalPlaces = */ 1);
  } else if (var == "BMS_SOC") {
    return String(relay->getBmsReportedSOC());
  } else if (var == "OVERRIDDEN_SOC") {
    return String(relay->getOverriddenSOC());
  } else if (var == "VOLTAGE_BASED_SOC") {
    return String(relay->getBatteryFuelGauge().getVoltageBasedSoc());
  } else if (var == "BOTTOM_SOC") {
    return String(relay->getBatteryFuelGauge().getState().bottomSoc);
  } else if (var == "TOP_SOC") {
    return String(relay->getBatteryFuelGauge().getState().topSoc);
  } else if (var == "BOTTOM_MILLIAMP_HOURS") {
    return String(
        relay->getBatteryFuelGauge().getState().bottomMilliampSeconds / 3600);
  } else if (var == "CURRENT_MILLIAMP_HOURS") {
    return String(
        relay->getBatteryFuelGauge().getState().currentMilliampSeconds / 3600);
  } else if (var == "USED_CHARGE_MAH") {
    return String(relay->getUsedChargeMah());
  } else if (var == "REGENERATED_CHARGE_MAH") {
    return String(relay->getRegeneratedChargeMah());
  } else if (var == "OWIE_version") {
    return owie_version;
  } else if (var == "SSID") {
    return Settings->ap_name;
  } else if (var == "PASS") {
    if (strlen(Settings->ap_password) > 0) {
      return defaultPass;
    }
    return "";
  } else if (var == "GRACEFUL_SHUTDOWN_COUNT") {
    return String(Settings->graceful_shutdown_count);
  } else if (var == "UPTIME") {
    return uptimeString();
  } else if (var == "IS_LOCKED") {
    return lockedStatusDataAttrValue();
  } else if (var == "CAN_ENABLE_LOCKING") {
    return lockingPreconditionsMet() ? "1" : "";
  } else if (var == "LOCKING_ENABLED") {
    return Settings->locking_enabled ? "1" : "";
  } else if (var == "PACKET_STATS_TABLE") {
    return renderPacketStatsTable();
  } else if (var == "BATTERY_PROFILE_OPTIONS") {
    return batteryProfileOptions();
  } else if (var == "BATTERY_REPORT_ROWS") {
    return batteryReportRows();
  } else if (var == "POWER_WATTS") {
    return String(relay->getTotalVoltageMillivolts() / 1000.0 *
                      relay->getCurrentMilliamps() / 1000.0,
                  0);
  } else if (var == "CELL_RESISTANCE_ROWS") {
    return cellResistanceRows();
  } else if (var == "CELL_VOLTAGE_TABLE") {
    const uint16_t *cellMillivolts = relay->getCellMillivolts();
    String out;
    out.reserve(256);
    for (int i = 0; i < 3; i++) {
      out.concat("<tr>");
      for (int j = 0; j < 5; j++) {
        out.concat("<td>");
        out.concat(cellMillivolts[i * 5 + j] / 1000.0);
        out.concat("</td>");
      }
      out.concat("<tr>");
    }
    return out;
  } else if (var == "TEMPERATURE_TABLE") {
    return getTempString();
  } else if (var == "AP_PASSWORD") {
    return Settings->ap_self_password;
  } else if (var == "AP_SELF_NAME") {
    return Settings->ap_self_name;
  } else if (var == "DISPLAY_AP_NAME") {
    char apDisplayName[64];
    if (strlen(Settings->ap_self_name) > 0) {
      snprintf(apDisplayName, sizeof(apDisplayName), "%s",
               Settings->ap_self_name);
    } else {
      snprintf(apDisplayName, sizeof(apDisplayName), "Owie-%04X",
               ESP.getChipId() & 0xFFFF);
    }
    return String(apDisplayName);
  } else if (var == "WIFI_POWER") {
    return String(Settings->wifi_power);
  } else if (var == "WIFI_POWER_OPTIONS") {
    String opts;
    opts.reserve(256);
    for (int i = 8; i < 18; i++) {
      opts.concat("<option value='");
      opts.concat(String(i));
      opts.concat("'");
      if (i == Settings->wifi_power) {
        opts.concat(" selected ");
      }
      opts.concat(">");
      opts.concat(String(i));
      opts.concat("</option>");
    }
    return opts;
  }
  return "<script>alert('UNKNOWN PLACEHOLDER')</script>";
}

}  // namespace

void setupWifi() {
  WiFi.setOutputPower(Settings->wifi_power);
  bool stationMode = (strlen(Settings->ap_name) > 0);
  WiFi.mode(stationMode ? WIFI_AP_STA : WIFI_AP);
  char apName[64];
  // sprintf isn't causing the issue of bungled SSID anymore (can't reproduce)
  // but snprintf should be safer, so trying that now
  // 9 bytes should be sufficient
  if (strlen(Settings->ap_self_name) > 0) {
    snprintf(apName, sizeof(apName), Settings->ap_self_name);
  } else {
    snprintf(apName, sizeof(apName), "Owie-%04X", ESP.getChipId() & 0xFFFF);
  }
  WiFi.softAP(apName, Settings->ap_self_password);
  if (stationMode) {
    WiFi.begin(Settings->ap_name, Settings->ap_password);
    WiFi.hostname(apName);
  }
  dnsServer.setErrorReplyCode(DNSReplyCode::NoError);
  dnsServer.start(53, "*", WiFi.softAPIP());  // DNS spoofing.
  TaskQueue.postRecurringTask([]() { dnsServer.processNextRequest(); });
}

void setupWebServer(BmsRelay *bmsRelay) {
  relay = bmsRelay;
  AsyncOta.listen(&webServer);
  webServer.addHandler(&ws);
  webServer.onNotFound([](AsyncWebServerRequest *request) {
    request->redirect("http://" + request->client()->localIP().toString() +
                      "/");
  });
  webServer.on("/favicon.ico", HTTP_GET,
               [](AsyncWebServerRequest *request) { request->send(404); });

  webServer.on("/autoupdate", HTTP_GET, [](AsyncWebServerRequest *request) {
    request->send(200, "application/json", generateOwieStatusJson());
  });

  webServer.on("/", HTTP_GET, [](AsyncWebServerRequest *request) {
    request->send_P(200, "text/html", INDEX_HTML_PROGMEM_ARRAY, INDEX_HTML_SIZE,
                    templateProcessor);
  });
  webServer.on("/styles.css", HTTP_GET, [](AsyncWebServerRequest *request) {
    AsyncWebServerResponse *response = request->beginResponse_P(
        200, "text/css", STYLES_CSS_PROGMEM_ARRAY, STYLES_CSS_SIZE);
    response->addHeader("Cache-Control", "max-age=3600");
    request->send(response);
  });
  webServer.on("/dev_settings", HTTP_GET, [](AsyncWebServerRequest *request) {
    AsyncWebServerResponse *response = request->beginResponse_P(
        200, "text/html", DEV_SETTINGS_HTML_PROGMEM_ARRAY,
        DEV_SETTINGS_HTML_SIZE, templateProcessor);
    response->addHeader("Cache-Control", "max-age=3600");
    request->send(response);
  });
  webServer.on("/battery", HTTP_ANY, [](AsyncWebServerRequest *request) {
    switch (request->method()) {
      case HTTP_GET:
        request->send_P(200, "text/html", BATTERY_HTML_PROGMEM_ARRAY,
                        BATTERY_HTML_SIZE, templateProcessor);
        return;
      case HTTP_POST:
        if (request->getParam("reset_stats", true) != nullptr) {
          relay->getBatteryFuelGauge().reset();
        } else if (request->getParam("reset_settings", true) != nullptr) {
          Settings->battery_state = BatteryStateMsg_init_default;
          saveSettings();
        } else if (request->getParam("reset_power", true) != nullptr) {
          relay->getPowerStats().reset();
        } else if (request->getParam("battery_profile", true) != nullptr) {
          uint32_t id =
              request->getParam("battery_profile", true)->value().toInt();
          if (id < BATTERY_PROFILE_COUNT) {
            Settings->battery_profile_id = id;
            saveSettings();
          }
        }
        request->redirect("/battery");
        return;
    }
    request->send(404);
  });
  webServer.on("/wifi", HTTP_ANY, [](AsyncWebServerRequest *request) {
    switch (request->method()) {
      case HTTP_GET:
        request->send_P(200, "text/html", WIFI_HTML_PROGMEM_ARRAY,
                        WIFI_HTML_SIZE, templateProcessor);
        return;
      case HTTP_POST:
        const auto ssidParam = request->getParam("s", true);
        const auto passwordParam = request->getParam("p", true);
        if (ssidParam == nullptr || passwordParam == nullptr ||
            ssidParam->value().length() > sizeof(Settings->ap_name) ||
            passwordParam->value().length() > sizeof(Settings->ap_password)) {
          request->send(200, "text/html", "Invalid SSID or Password.");
          return;
        }
        snprintf(Settings->ap_name, sizeof(Settings->ap_name), "%s",
                 ssidParam->value().c_str());
        snprintf(Settings->ap_password, sizeof(Settings->ap_password), "%s",
                 passwordParam->value().c_str());
        saveSettingsAndRestartSoon();
        request->send(200, "text/html", "WiFi settings saved, restarting...");
        return;
    }
    request->send(404);
  });
  webServer.on("/monitor", HTTP_GET, [](AsyncWebServerRequest *request) {
    request->send_P(200, "text/html", MONITOR_HTML_PROGMEM_ARRAY,
                    MONITOR_HTML_SIZE, templateProcessor);
  });
  webServer.on("/settings", HTTP_ANY, [](AsyncWebServerRequest *request) {
    switch (request->method()) {
      case HTTP_GET:
        request->send_P(200, "text/html", SETTINGS_HTML_PROGMEM_ARRAY,
                        SETTINGS_HTML_SIZE, templateProcessor);
        return;
      case HTTP_POST:
        const auto apSelfPassword = request->getParam("pw", true);
        const auto apSelfName = request->getParam("apselfname", true);
        const auto wifiPower = request->getParam("wifipower", true);
        if (apSelfPassword == nullptr ||
            apSelfPassword->value().length() >
                sizeof(Settings->ap_self_password) ||
            (apSelfPassword->value().length() < 8 &&
             apSelfPassword->value().length() >
                 0)) {  // this check is necessary so the user can't set a too
                        // small password and thus the network wont' show up
          request->send(400, "text/html",
                        "AP password must be between 8 and 31 characters");
          return;
        }
        if (apSelfName == nullptr ||
            apSelfName->value().length() > sizeof(Settings->ap_self_name) ||
            (apSelfName->value().length() < 1 &&
             apSelfName->value().length() > 0)) {
          request->send(400, "text/html", "Invalid Custom AP Name.");
          return;
        }

        // Set wifi power
        // add aditional sanity checks, so that the power range is between 8 and
        // 17 only!
        if (wifiPower == nullptr || wifiPower->value().toInt() < 8 ||
            wifiPower->value().toInt() > 17) {
          request->send(
              400, "text/html",
              "Wifi Power range MUST be between 8 (dBm) and 17 (dBm).");
          return;
        }
        Settings->wifi_power = wifiPower->value().toInt();
        snprintf(Settings->ap_self_password, sizeof(Settings->ap_self_password),
                 "%s", apSelfPassword->value().c_str());
        snprintf(Settings->ap_self_name, sizeof(Settings->ap_self_name), "%s",
                 apSelfName->value().c_str());
        saveSettingsAndRestartSoon();
        request->send(200, "text/html", "Settings saved, restarting...");
        return;
    }
    request->send(404);
  });
  webServer.on("/lock", HTTP_GET, [](AsyncWebServerRequest *request) {
    if (request->hasParam("unlock")) {
      Settings->is_locked = false;
      saveSettings();
      request->send(200, "text/html", "Board unlocked, restart your board.");
      return;
    } else if (request->hasParam("toggleArm")) {
      if (!lockingPreconditionsMet()) {
        request->send(500, "text/html",
                      "Cannot enable locking with empty WiFi password");
        return;
      }
      Settings->locking_enabled = !Settings->locking_enabled;
      Settings->is_locked = false;
      saveSettings();
      request->send(200, "text/html", Settings->locking_enabled ? "1" : "");
      return;
    }
    request->send(404);
  });

  webServer.begin();
}

void streamBMSPacket(uint8_t *const data, size_t len) {
  ws.binaryAll((char *const)data, len);
}
