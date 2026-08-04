---
name: owie-flash-ota
description: Use when deploying Owie firmware over WiFi (OTA) instead of USB, once the board has joined a network — or when deciding between USB and over-the-air flashing, or an OTA upload can't reach the board.
---

# Owie OTA (WiFi) flash

## Overview
When a board is on WiFi and reachable from the build machine, flash it over the network — no cable. Owie serves an OTA endpoint at `/update`; the `ota` PlatformIO env POSTs the firmware there.

## Preconditions
- Board has joined a network (STA mode) and has an IP/hostname.
- **The build machine can reach the board.** Hidden/guest networks often enable wireless client isolation: a wired machine can resolve the board via ARP but ping/HTTP to it fail. If so, flash from a device on the *same wireless* network.
- Verify reachability first — this must return JSON:
  ```
  curl -s -m5 http://<board>/autoupdate
  ```

## Procedure
1. Point the `ota` env at the target board in `platformio.ini`:
   ```
   [env:ota]
   ...
   custom_upload_url = http://<board-host-or-ip>/update
   ```
   e.g. `http://172.16.1.121/update` or `http://Owie-6F5B.local/update`. Don't commit a machine-/board-specific address — override locally or revert afterward.
2. Flash:
   ```
   pio run -e ota -t upload
   ```
3. The board flashes, verifies, and reboots — keep it powered until its WiFi returns.

## Notes
- Hostname is `Owie-XXXX`, from the chip ID (lower 16 bits of the MAC). The resolution suffix depends on the router (`.local` via mDNS, or the router's own domain).
- OTA overwrites the sketch but preserves saved settings.
- For USB flashing (or when OTA can't reach the board), see the `owie-flash-usb` skill.
