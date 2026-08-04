---
name: owie-build
description: Use when building, compiling, or unit-testing the Owie ESP8266 firmware, setting up its PlatformIO toolchain, or diagnosing build failures like nanopb "No module named google", a missing html-minifier-terser, or the % template-processor footgun in data/*.html.
---

# Owie firmware build

## Overview
Owie is ESP8266 (Wemos D1 Mini) firmware built with PlatformIO. This covers building, native unit tests, the one-time toolchain setup, and the two gotchas that bite most often.

## Quick reference
| Task | Command |
|---|---|
| Build firmware | `pio run -e d1_mini_lite_clone` |
| Native unit tests | `pio test -e native` |
| Run one native test | `pio test -e native -f <test_dir>` |
| Flash over USB | see the `owie-flash-usb` skill |
| Flash over WiFi | see the `owie-flash-ota` skill |

Firmware is written to `.pio/build/d1_mini_lite_clone/firmware.bin`.

## Toolchain setup (one-time, macOS)
- PlatformIO via pipx: `pipx install platformio`
- **Inject protobuf** into PlatformIO's venv, or nanopb codegen fails with `ModuleNotFoundError: No module named 'google'`:
  `pipx inject platformio protobuf`
- html-minifier-terser (inlines the web UI into flash at build time):
  `npm i -g html-minifier-terser`

## Native test baseline (known failures)
`test_battery_fuel_gauge` has **2 pre-existing failures** from unfinished fuel-gauge work: `Expected 123 Was 0` and `Expected 3600000 Was 3599400`. These are NOT regressions. Any new tests must pass, and you must not increase the failure count.

## The `%` template footgun (data/*.html)
Pages served through ESPAsyncWebServer's template processor treat `%` as a placeholder delimiter, and an unknown `%TOKEN%` makes the firmware inject `alert('UNKNOWN PLACEHOLDER')` at runtime. So every templated `data/*.html` must contain **no stray `%`** — only real `%PLACEHOLDER%` tokens and `%%` for a literal percent.
- In JS use `& 15`, not `i % 16`.
- Keep CSS percentages in the non-templated `styles.css`.
- Inside a template-processor *return string* (C++), literal `%` is fine, but prefer entities like `&#37;` (%) / `&#8486;` (Ω).

Audit any page you edit (expect `stray %: 0`):
```
python3 -c "import re; s=open('data/PAGE.html').read(); s=re.sub(r'%[A-Za-z_][A-Za-z0-9_]*%','',s); s=s.replace('%%',''); print('stray %:', s.count('%'))"
```
