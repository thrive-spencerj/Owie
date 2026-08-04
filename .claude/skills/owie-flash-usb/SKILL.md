---
name: owie-flash-usb
description: Use when flashing Owie firmware to a Wemos D1 Mini over USB, or when esptool upload fails with timeouts, "Failed to write to target RAM", "Failed to read register", 524288-baud errors, or the CH340 serial port not enumerating / disappearing.
---

# Owie USB flash

## Overview
Flash Owie to a Wemos D1 Mini (CH340 USB-serial). The repo's `upload_speed = 524288` is too fast for cheap CH340 clones and times out mid-transfer — flash at **115200** instead, then restore the config so the repo stays unchanged.

## Quick reference
| Step | How |
|---|---|
| Find the port | `pio device list` — CH340 shows `VID:PID=1A86:7523` (e.g. `/dev/cu.usbserial-10`) |
| Flash | 115200 override procedure below |
| Success marker | `Hash of data verified.` then `Hard resetting…` |

## Flash procedure (115200 override)
Lower the baud just for this flash, then restore `platformio.ini`:
```
cp platformio.ini /tmp/pio.ini.bak
sed -i '' 's/^upload_speed = 524288/upload_speed = 115200/' platformio.ini
pio run -e d1_mini_lite_clone -t upload --upload-port /dev/cu.usbserial-10
cp /tmp/pio.ini.bak platformio.ini    # restore repo config
```
(Linux: use `sed -i` without the `''`.)

Confirm afterward that `platformio.ini` is back to `524288` and `git status` shows it clean.

## Troubleshooting
- **Port missing / disappears / won't enumerate:** flaky CH340 or a charge-only cable. Reseat, use a different USB port (no hub), or swap to a known-good **data** cable. Re-check with `pio device list`. The port often re-appears within seconds — poll before giving up.
- **`Failed to write to target RAM`, `Failed to read register`, or a timeout mid-handshake:** an unstable physical link (cable/port), NOT firmware. These fail *before* any flash write starts, so the board's existing firmware is untouched — fix the connection and retry. It flashes in one clean pass when the link is solid.
- On success the board hard-resets into the new firmware and its `Owie-XXXX` AP (from the chip ID) comes back up.
