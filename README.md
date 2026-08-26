# @aaronge/rpi-health

Raspberry Pi 5 firmware and power telemetry — throttle/under-voltage sticky
faults, PMIC rail currents/voltages, clocks, and EEPROM/bootloader status —
as a typed, versioned Swamp model. Every method talks to the VideoCore
firmware via `vcgencmd` (and `rpi-eeprom-update` for firmware state), so
it's deliberately **Pi-specific** and will not run anywhere else.

Contains no portable telemetry. Disk, load, memory, and sysfs thermal
readings live in the separate `@aaronge/host-health` extension — this
model does not duplicate them.

Target: Raspberry Pi 5 Model B, Debian 13 (trixie), arm64. `readPmic`
additionally requires a Pi 5 specifically (earlier models have no PMIC
ADC) and returns a clean error on unsupported hardware.

## Installation

```sh
swamp extension pull @aaronge/rpi-health
```

## Usage

```sh
swamp model create @aaronge/rpi-health rpi-local \
  --global-arg 'tempSoftLimitCelsius=80' \
  --global-arg 'minSupplyVolts=4.8'

swamp model method run rpi-local readThrottle
swamp model method run rpi-local readClocks
swamp model method run rpi-local readPmic
swamp model method run rpi-local readFirmware
```

Each method writes one resource: `throttle`, `clocks`, `pmic`, `firmware`.
Every field is described — run `swamp model type describe @aaronge/rpi-health`
to see the full schema.

Reference the latest snapshot from a workflow assert step or another model:

```yaml
expr: >-
  data.latest("rpi-local", "throttle").attributes.healthy == true
```

## Global arguments

| Arg                    | Default     | Notes                                       |
| ----------------------- | ----------- | -------------------------------------------- |
| `tempSoftLimitCelsius`  | `80`        | Pi 5 soft throttle point.                     |
| `tempHardLimitCelsius`  | `85`        | Pi 5 hard throttle point.                     |
| `minSupplyVolts`        | `4.8`       | `EXT5V_V` floor before concern.               |
| `vcgencmdPath`          | `"vcgencmd"`| Override for odd installs.                    |

These thresholds aren't consumed by the methods themselves — they document
the intended limits for a given Pi. A workflow that asserts against them
declares matching `inputs` with the same defaults (see the bundled
`rpi-health` workflow) since a workflow's CEL expressions can't reach into
a model definition's global arguments directly.

## How it works

- **`throttle`** — decodes `vcgencmd get_throttled`'s hex bitfield into
  named `now.*` (instantaneous, bits 0-3) and `sinceBoot.*` (sticky, bits
  16-19) flags. The sticky bits are the entire value proposition: they
  latch on first occurrence and never self-clear until reboot, so
  `sinceBoot.underVoltage: true` alongside `now.underVoltage: false` means
  "a brownout happened, not that one is happening right now." `healthy` is
  `true` only when the whole bitfield is zero.
- **`pmic`** (Pi 5 only) — parses `vcgencmd pmic_read_adc`'s whitespace-
  separated current/voltage entries, pairing each rail's `_A`/`_V` suffix
  by base name (careful with names like `3V7_WL_SW` that embed a `V`
  themselves). `EXT5V_V` and `BATT_V` have no matching current entry and
  are hoisted to `supplyVolts`/`batteryVolts` rather than left as orphan
  rail entries. `estimatedTotalWatts` sums the rail wattages, but the PMIC
  can't measure the main 5V input rail's current — an idle Pi 5 drawing
  ~3W externally measured reports ~2.2-3.5W here. Useful as a relative
  trend, not an absolute wattmeter.
- **`clocks`** — arm/core/v3d/isp/hevc clock frequencies plus core
  temperature and core voltage, all from `vcgencmd`. `coreTempCelsius`
  intentionally duplicates host-health's sysfs thermal reading via a
  different path — useful for occasional cross-checking, not redundant to
  remove.
- **`firmware`** — model identification (NUL-stripped
  `/proc/device-tree/model`), raw `vcgencmd version` output, and
  EEPROM/bootloader status from `rpi-eeprom-update`. That command can exit
  non-zero on a perfectly successful read (exit 1 just means "an update is
  available"), so the parser reads stdout content rather than trusting the
  exit code. A genuinely unreadable `rpi-eeprom-update` (e.g. missing
  permissions) degrades to `null` EEPROM fields while still writing the
  resource with `model`/`firmwareVersion` populated — a partial result
  beats no result.

Every method refuses to run on non-Pi hardware — checking
`/proc/device-tree/model` names a Raspberry Pi and that `vcgencmd` is on
PATH — before writing anything. No sysfs fallback; that degradation path
belongs to `@aaronge/host-health`.

## Workflow

The extension ships an `rpi-health` workflow: a `collect` job runs
`readThrottle`, `readClocks`, and `readPmic` in parallel, an `assert` job
checks throttle health, core temperature, and supply voltage against a
threshold (`allowFailure: false` — a failed run is the signal, including
after a single past brownout, since the sticky bits stay latched until
reboot), and a `report` job prints a one-screen summary regardless of
whether the assert job passed. It's scheduled every 5 minutes via
`trigger.schedule`.

`readFirmware` is intentionally excluded from this workflow — EEPROM/
bootloader checks change rarely and belong in a separate, much less
frequent workflow (not yet built). `readNvmeHealth` (wrapping `smartctl`)
is planned for once an NVMe SSD is physically installed.
