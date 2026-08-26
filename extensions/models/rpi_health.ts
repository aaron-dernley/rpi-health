/**
 * Raspberry Pi 5 firmware and power telemetry via `vcgencmd`. Deliberately
 * Pi-specific — every method refuses to run unless `/proc/device-tree/model`
 * names a Raspberry Pi and `vcgencmd` is on PATH. Portable telemetry (disk,
 * load, memory, sysfs thermal) lives in `@aaronge/host-health`; this model
 * does not duplicate it. Read-only: no config.txt mutation, no overclocking,
 * no GPIO.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Minimal logger shape methods depend on — matches `context.logger`. */
export interface MinimalLogger {
  /** Log a user-visible progress or state-transition message. */
  info(msg: string, props?: Record<string, unknown>): void;
  /** Log a recoverable issue or degraded-behavior message. */
  warn(msg: string, props?: Record<string, unknown>): void;
}

/**
 * Read a text file via `cat` rather than `Deno.readTextFile`. `/proc` files
 * (like `/proc/device-tree/model`) report a `stat()` size of 0 and trip
 * Deno's permission checker into demanding the literal `--allow-all` flag —
 * no scoped `--allow-read` satisfies it, even though the file is
 * world-readable either way. Same workaround `@aaronge/host-health` uses.
 */
async function catFile(path: string): Promise<string> {
  const cmd = new Deno.Command("cat", {
    args: [path],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    throw new Error(
      `cat ${path} failed: ${new TextDecoder().decode(output.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(output.stdout);
}

/** Result of the hardware guard every method runs before doing real work. */
export interface PiHardwareInfo {
  /** `/proc/device-tree/model`, NUL byte stripped. */
  model: string;
  /** True when `model` names a Raspberry Pi 5 specifically. */
  isPi5: boolean;
}

/**
 * Confirm `vcgencmd` is executable at `vcgencmdPath`. Any outcome other than
 * `Deno.errors.NotFound` counts as "found" — a non-zero exit from running
 * with no arguments is still evidence the binary exists and ran.
 */
async function checkVcgencmdOnPath(vcgencmdPath: string): Promise<void> {
  try {
    const cmd = new Deno.Command(vcgencmdPath, {
      args: [],
      stdout: "piped",
      stderr: "piped",
    });
    await cmd.output();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `vcgencmd not found on PATH (looked for "${vcgencmdPath}"). ` +
          `It ships in raspberrypi-utils. Set the vcgencmdPath global ` +
          `argument if it lives somewhere nonstandard.`,
      );
    }
    throw error;
  }
}

/**
 * Hardware guard every method calls before writing any resource. Refuses to
 * run on non-Pi hardware rather than producing nonsense, and never falls
 * back to sysfs — that degradation path belongs to `@aaronge/host-health`.
 */
export async function assertRaspberryPiHardware(
  vcgencmdPath: string,
): Promise<PiHardwareInfo> {
  let rawModel: string;
  try {
    rawModel = await catFile("/proc/device-tree/model");
  } catch (error) {
    throw new Error(
      `This model requires Raspberry Pi hardware: /proc/device-tree/model ` +
        `is missing or unreadable (${
          error instanceof Error ? error.message : String(error)
        }). Refusing to fall back to sysfs — that's @aaronge/host-health's job.`,
    );
  }
  // The kernel reports this value NUL-terminated, not newline-terminated.
  const model = rawModel.replace(/\0+$/, "").trim();
  if (!model.includes("Raspberry Pi")) {
    throw new Error(
      `This model requires Raspberry Pi hardware: /proc/device-tree/model ` +
        `reports "${model}", which does not contain "Raspberry Pi".`,
    );
  }
  await checkVcgencmdOnPath(vcgencmdPath);
  return { model, isPi5: model.includes("Raspberry Pi 5") };
}

/**
 * Guard for Pi-5-only methods (currently just readPmic). Earlier Pi models
 * have no PMIC ADC and pmic_read_adc fails on them — this throws a clean,
 * named error instead of letting that failure surface as a raw crash.
 */
export function assertPi5Supported(hardware: PiHardwareInfo): void {
  if (!hardware.isPi5) {
    throw new Error(
      `readPmic is unsupported on this model: the PMIC ADC (pmic_read_adc) ` +
        `requires a Raspberry Pi 5. Detected: "${hardware.model}".`,
    );
  }
}

const GlobalArgsSchema = z.object({
  tempSoftLimitCelsius: z.number().default(80).describe(
    "Pi 5 soft throttle point in Celsius. Not consumed by any method " +
      "directly — read by the rpi-health workflow's assert job.",
  ),
  tempHardLimitCelsius: z.number().default(85).describe(
    "Pi 5 hard throttle point in Celsius. Not consumed by any method " +
      "directly.",
  ),
  minSupplyVolts: z.number().default(4.8).describe(
    "EXT5V_V floor before concern. Not consumed by any method directly.",
  ),
  vcgencmdPath: z.string().default("vcgencmd").describe(
    "Path to the vcgencmd binary. Override for odd installs where it isn't " +
      "on PATH under its normal name.",
  ),
});

/** Validated global arguments for a `@aaronge/rpi-health` model instance. */
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ThrottleFlagsNowSchema = z.object({
  underVoltage: z.boolean().describe(
    "Bit 0: under-voltage detected at the instant of sampling. Can read " +
      "false even minutes after a real brownout — see sinceBoot.underVoltage " +
      "for the latched signal.",
  ),
  armFrequencyCapped: z.boolean().describe(
    "Bit 1: ARM frequency capped at the instant of sampling.",
  ),
  throttled: z.boolean().describe(
    "Bit 2: currently throttled at the instant of sampling.",
  ),
  softTempLimitActive: z.boolean().describe(
    "Bit 3: soft temperature limit active at the instant of sampling.",
  ),
});

const ThrottleFlagsSinceBootSchema = z.object({
  underVoltage: z.boolean().describe(
    "Bit 16, STICKY: under-voltage has occurred at any point since boot. " +
      "Latches on first occurrence and never self-clears until reboot — " +
      "this is the alarming field. A 3am brownout leaves now.underVoltage " +
      "false but this true; that combination means 'it happened, not now.'",
  ),
  armFrequencyCapped: z.boolean().describe(
    "Bit 17, STICKY: ARM frequency capping has occurred since boot.",
  ),
  throttled: z.boolean().describe(
    "Bit 18, STICKY: throttling has occurred since boot.",
  ),
  softTempLimitReached: z.boolean().describe(
    "Bit 19, STICKY: soft temperature limit has been reached since boot.",
  ),
});

const ThrottleSchema = z.object({
  raw: z.string().describe(
    "Verbatim hex string from vcgencmd get_throttled, e.g. \"0x50000\".",
  ),
  rawValue: z.number().describe("raw parsed as an integer via parseInt(hex, 16)."),
  now: ThrottleFlagsNowSchema.describe(
    "Instantaneous flags (bits 0-3): the state at the moment of sampling. " +
      "Usually clean even on a machine that browned out an hour ago.",
  ),
  sinceBoot: ThrottleFlagsSinceBootSchema.describe(
    "Sticky flags (bits 16-19): latched since boot. These are the reason " +
      "this model exists — they record faults that left no other trace.",
  ),
  healthy: z.boolean().describe(
    "True only when rawValue == 0 — every bit clear, current and " +
      "historical. Any fault, past or present, makes this false.",
  ),
  capturedAt: z.string().describe("ISO-8601 timestamp when this snapshot was captured."),
});

/** Parse `vcgencmd get_throttled` output (e.g. "throttled=0x50000") into typed flags. */
export function parseThrottled(vcgencmdOutput: string): {
  raw: string;
  rawValue: number;
  now: z.infer<typeof ThrottleFlagsNowSchema>;
  sinceBoot: z.infer<typeof ThrottleFlagsSinceBootSchema>;
  healthy: boolean;
} {
  const parts = vcgencmdOutput.trim().split("=");
  if (parts.length < 2) {
    throw new Error(
      `Unexpected vcgencmd get_throttled output: "${vcgencmdOutput.trim()}"`,
    );
  }
  const raw = parts[1].trim();
  const rawValue = parseInt(raw, 16);
  if (!Number.isFinite(rawValue)) {
    throw new Error(`Could not parse hex value from get_throttled: "${raw}"`);
  }
  const bit = (mask: number) => (rawValue & mask) !== 0;
  return {
    raw,
    rawValue,
    now: {
      underVoltage: bit(0x1),
      armFrequencyCapped: bit(0x2),
      throttled: bit(0x4),
      softTempLimitActive: bit(0x8),
    },
    sinceBoot: {
      underVoltage: bit(0x10000),
      armFrequencyCapped: bit(0x20000),
      throttled: bit(0x40000),
      softTempLimitReached: bit(0x80000),
    },
    healthy: rawValue === 0,
  };
}

const ClockReadingSchema = z.object({
  name: z.string().describe("Clock domain name: arm, core, v3d, isp, or hevc."),
  hertz: z.number().describe("Clock frequency in Hz, from vcgencmd measure_clock."),
});

const ClocksSchema = z.object({
  clocks: z.array(ClockReadingSchema).describe(
    "One entry per measured clock domain (arm, core, v3d, isp, hevc).",
  ),
  armHertz: z.number().describe(
    "ARM clock in Hz, hoisted from the clocks array for readable CEL asserts.",
  ),
  coreTempCelsius: z.number().describe(
    "SoC temperature from vcgencmd measure_temp. Duplicates " +
      "@aaronge/host-health's sysfs thermal reading via a different path — " +
      "intentional, for occasional cross-checking, not redundant to remove.",
  ),
  coreVolts: z.number().describe("Core voltage in volts, from vcgencmd measure_volts core."),
  capturedAt: z.string().describe("ISO-8601 timestamp when this snapshot was captured."),
});

const CLOCK_DOMAINS = ["arm", "core", "v3d", "isp", "hevc"] as const;

/** Parse `vcgencmd measure_clock <name>` output (e.g. "frequency(0)=1500000000"). */
export function parseClockOutput(output: string): number {
  const parts = output.trim().split("=");
  if (parts.length < 2) {
    throw new Error(`Unexpected vcgencmd measure_clock output: "${output.trim()}"`);
  }
  const hertz = Number(parts[1].trim());
  if (!Number.isFinite(hertz)) {
    throw new Error(`Could not parse frequency from measure_clock: "${parts[1]}"`);
  }
  return hertz;
}

/** Parse `vcgencmd measure_temp` output (e.g. "temp=58.2'C") into a Celsius number. */
export function parseTempOutput(output: string): number {
  const match = /^temp=(-?[\d.]+)'C\s*$/.exec(output.trim());
  if (!match) {
    throw new Error(`Unexpected vcgencmd measure_temp output: "${output.trim()}"`);
  }
  const celsius = Number(match[1]);
  if (!Number.isFinite(celsius)) {
    throw new Error(`Could not parse Celsius value from measure_temp: "${match[1]}"`);
  }
  return celsius;
}

/** Parse `vcgencmd measure_volts <rail>` output (e.g. "volt=0.9053V") into a volts number. */
export function parseVoltsOutput(output: string): number {
  const match = /^volt=(-?[\d.]+)V\s*$/.exec(output.trim());
  if (!match) {
    throw new Error(`Unexpected vcgencmd measure_volts output: "${output.trim()}"`);
  }
  const volts = Number(match[1]);
  if (!Number.isFinite(volts)) {
    throw new Error(`Could not parse volts value from measure_volts: "${match[1]}"`);
  }
  return volts;
}

const PmicRailSchema = z.object({
  name: z.string().describe(
    "Rail base name with the _A/_V current/voltage suffix stripped, e.g. " +
      "\"VDD_CORE\", \"3V3_SYS\", \"3V7_WL_SW\".",
  ),
  volts: z.number().nullable().describe(
    "Rail voltage, or null when pmic_read_adc reported no voltage entry " +
      "for this rail. Null means unknown; it never means the rail is off.",
  ),
  amps: z.number().nullable().describe(
    "Rail current, or null when pmic_read_adc reported no current entry " +
      "for this rail. Null means unknown; it never means zero draw.",
  ),
  watts: z.number().nullable().describe(
    "volts * amps, or null when either is missing.",
  ),
});

const PmicSchema = z.object({
  rails: z.array(PmicRailSchema).describe(
    "One entry per paired current/voltage rail from vcgencmd pmic_read_adc. " +
      "EXT5V and BATT are excluded here — see supplyVolts/batteryVolts.",
  ),
  supplyVolts: z.number().nullable().describe(
    "EXT5V_V — what the PSU is actually delivering. Null if unreadable.",
  ),
  batteryVolts: z.number().nullable().describe(
    "BATT_V — the RTC coin-cell voltage. Null if unreadable.",
  ),
  estimatedTotalWatts: z.number().describe(
    "Sum of all rail watts. CAVEAT: the PMIC cannot measure current on the " +
      "main 5V input rail, so this systematically understates real " +
      "consumption — an idle Pi 5 drawing ~3W externally measured reports " +
      "around ~2.2W here. Useful as a relative trend across samples; a bad " +
      "absolute wattmeter.",
  ),
  capturedAt: z.string().describe("ISO-8601 timestamp when this snapshot was captured."),
});

/** One rail's parsed current/voltage/wattage. */
export interface PmicRail {
  /** Rail base name, current/voltage suffix stripped. */
  name: string;
  /** Rail voltage, or null when unreported. */
  volts: number | null;
  /** Rail current, or null when unreported. */
  amps: number | null;
  /** volts * amps, or null when either is missing. */
  watts: number | null;
}

/** Parsed `vcgencmd pmic_read_adc` output. */
export interface PmicReading {
  /** Paired rails, EXT5V/BATT excluded (see supplyVolts/batteryVolts). */
  rails: PmicRail[];
  /** EXT5V_V, or null if unreported. */
  supplyVolts: number | null;
  /** BATT_V, or null if unreported. */
  batteryVolts: number | null;
  /** Sum of rail watts — see the schema description's underestimation caveat. */
  estimatedTotalWatts: number;
}

/**
 * Parse `vcgencmd pmic_read_adc` output into paired rails. Entries may be
 * newline- or space-separated depending on shell context, so this splits on
 * whitespace and pairs (label, value) tokens rather than assuming one entry
 * per line. Each label ends in exactly "_A" (current) or "_V" (voltage) —
 * only that confirmed 2-character suffix is stripped, since rail names
 * themselves contain "V" (e.g. "3V7_WL_SW_A" -> base "3V7_WL_SW"). EXT5V and
 * BATT have voltage but no matching current entry; they're hoisted to their
 * own fields rather than left as orphan half-populated rail entries.
 */
export function parsePmicReadAdc(text: string): PmicReading {
  const tokens = text.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0 || tokens.length % 2 !== 0) {
    throw new Error(
      `Unexpected vcgencmd pmic_read_adc output: odd or empty token count (${tokens.length})`,
    );
  }

  const valueRe = /^(current|volt)\(\d+\)=(-?[\d.]+)([AV])$/;
  const bases = new Map<string, { volts: number | null; amps: number | null }>();

  for (let i = 0; i < tokens.length; i += 2) {
    const label = tokens[i];
    const valueToken = tokens[i + 1];
    const suffix = label.slice(-2);
    if (suffix !== "_A" && suffix !== "_V") {
      throw new Error(
        `Unexpected pmic_read_adc label (expected _A/_V suffix): "${label}"`,
      );
    }
    const base = label.slice(0, -2);
    const match = valueRe.exec(valueToken);
    if (!match) {
      throw new Error(
        `Unexpected pmic_read_adc value for ${label}: "${valueToken}"`,
      );
    }
    const value = Number(match[2]);
    if (!Number.isFinite(value)) {
      throw new Error(`Could not parse numeric value for ${label}: "${match[2]}"`);
    }
    const entry = bases.get(base) ?? { volts: null, amps: null };
    if (suffix === "_A") {
      entry.amps = value;
    } else {
      entry.volts = value;
    }
    bases.set(base, entry);
  }

  let supplyVolts: number | null = null;
  let batteryVolts: number | null = null;
  const rails: PmicRail[] = [];
  let estimatedTotalWatts = 0;

  for (const [base, { volts, amps }] of bases) {
    if (base === "EXT5V") {
      supplyVolts = volts;
      continue;
    }
    if (base === "BATT") {
      batteryVolts = volts;
      continue;
    }
    const watts = volts !== null && amps !== null ? volts * amps : null;
    if (watts !== null) estimatedTotalWatts += watts;
    rails.push({ name: base, volts, amps, watts });
  }

  return {
    rails,
    supplyVolts,
    batteryVolts,
    estimatedTotalWatts: Math.round(estimatedTotalWatts * 1000) / 1000,
  };
}

const FirmwareSchema = z.object({
  model: z.string().describe(
    "/proc/device-tree/model, NUL byte stripped, e.g. " +
      "\"Raspberry Pi 5 Model B Rev 1.1\".",
  ),
  isPi5: z.boolean().describe("True when model names a Raspberry Pi 5 specifically."),
  eepromCurrent: z.string().nullable().describe(
    "Installed EEPROM/bootloader build date, from rpi-eeprom-update's " +
      "CURRENT line. Null when rpi-eeprom-update could not be read " +
      "(commonly a permissions issue) — a partial firmware resource with " +
      "just model/firmwareVersion still gets written in that case.",
  ),
  eepromLatest: z.string().nullable().describe(
    "Latest available EEPROM/bootloader build date, from rpi-eeprom-update's " +
      "LATEST line. Null when unavailable.",
  ),
  eepromUpToDate: z.boolean().nullable().describe(
    "Whether the installed EEPROM matches the latest available, from " +
      "rpi-eeprom-update's own BOOTLOADER: status line. Null when that " +
      "status line could not be read or parsed.",
  ),
  bootloaderVersion: z.string().nullable().describe(
    "Bootloader release channel, from rpi-eeprom-update's RELEASE line. " +
      "Null when unavailable.",
  ),
  firmwareVersion: z.string().describe(
    "Raw, multiline vcgencmd version output. Intentionally not parsed — " +
      "its format has changed across firmware revisions and will again.",
  ),
  capturedAt: z.string().describe("ISO-8601 timestamp when this snapshot was captured."),
});

/** Parsed `rpi-eeprom-update` output; every field is null when the command's output couldn't be read at all. */
export interface EepromInfo {
  /** Installed EEPROM/bootloader build date, or null. */
  current: string | null;
  /** Latest available EEPROM/bootloader build date, or null. */
  latest: string | null;
  /** Whether installed matches latest, per the command's own status line, or null. */
  upToDate: boolean | null;
  /** Bootloader release channel, or null. */
  bootloaderVersion: string | null;
}

/**
 * Parse `rpi-eeprom-update` output. On this class of hardware the command
 * can exit non-zero on plain success (e.g. exit 1 simply means "an update
 * is available", not "permission denied") — so this parses stdout content
 * directly rather than trusting the exit code. Only the *absence* of a
 * CURRENT: line (the unambiguous permission-denied/not-installed case)
 * degrades to all-null fields; a present CURRENT: line is trusted even
 * alongside a non-zero exit.
 */
export function parseEepromUpdate(
  stdout: string,
  stderr: string,
  logger?: MinimalLogger,
): EepromInfo {
  const currentMatch = /^\s*CURRENT:\s*(.+)$/m.exec(stdout);
  const latestMatch = /^\s*LATEST:\s*(.+)$/m.exec(stdout);
  const releaseMatch = /^\s*RELEASE:\s*(.+)$/m.exec(stdout);
  const bootloaderMatch = /^\s*BOOTLOADER:\s*(.+)$/m.exec(stdout);

  if (!currentMatch) {
    logger?.warn(
      "rpi-eeprom-update produced no CURRENT: line (likely needs root); " +
        "EEPROM fields will be null: {stderr}",
      { stderr: stderr.trim() },
    );
    return { current: null, latest: null, upToDate: null, bootloaderVersion: null };
  }

  const current = currentMatch[1].trim();
  const latest = latestMatch ? latestMatch[1].trim() : null;
  const bootloaderVersion = releaseMatch ? releaseMatch[1].trim() : null;
  let upToDate: boolean | null = null;
  if (bootloaderMatch) {
    const status = bootloaderMatch[1].trim().toLowerCase();
    if (status.includes("up to date")) upToDate = true;
    else if (status.includes("update available")) upToDate = false;
  }

  return { current, latest, upToDate, bootloaderVersion };
}

/** Model definition for `@aaronge/rpi-health` — Pi 5 firmware and power telemetry. */
export const model = {
  type: "@aaronge/rpi-health",
  version: "2026.08.26.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    throttle: {
      description:
        "vcgencmd get_throttled, decoded into named now/sinceBoot flags. " +
        "The sticky sinceBoot bits are the entire value proposition of this " +
        "model — they survive after the instantaneous now bits clear.",
      schema: ThrottleSchema,
      lifetime: "infinite" as const,
      garbageCollection: 500,
    },
    clocks: {
      description:
        "Clock frequencies (arm, core, v3d, isp, hevc), core temperature, " +
        "and core voltage, all from vcgencmd.",
      schema: ClocksSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
    pmic: {
      description:
        "Pi 5 PMIC rail currents/voltages from vcgencmd pmic_read_adc. " +
        "Unsupported on earlier Pi models, which have no PMIC ADC.",
      schema: PmicSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
    firmware: {
      description:
        "Model identification, EEPROM/bootloader status, and raw vcgencmd " +
        "version output. Changes almost never — GC'd less aggressively.",
      schema: FirmwareSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    readThrottle: {
      description:
        "Run vcgencmd get_throttled, decode the bitfield, and write the " +
        "throttle resource.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: MinimalLogger;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        await assertRaspberryPiHardware(context.globalArgs.vcgencmdPath);
        const capturedAt = new Date().toISOString();

        context.logger.info("Reading throttle state via vcgencmd get_throttled");
        const cmd = new Deno.Command(context.globalArgs.vcgencmdPath, {
          args: ["get_throttled"],
          stdout: "piped",
          stderr: "piped",
        });
        const output = await cmd.output();
        if (!output.success) {
          throw new Error(
            `vcgencmd get_throttled failed: ${
              new TextDecoder().decode(output.stderr).trim()
            }`,
          );
        }
        const { raw, rawValue, now, sinceBoot, healthy } = parseThrottled(
          new TextDecoder().decode(output.stdout),
        );

        if (sinceBoot.underVoltage || sinceBoot.throttled) {
          context.logger.warn(
            "Sticky fault latched since boot: underVoltage={underVoltage} throttled={throttled} (raw={raw})",
            { underVoltage: sinceBoot.underVoltage, throttled: sinceBoot.throttled, raw },
          );
        }
        context.logger.info("Captured throttle state: raw={raw} healthy={healthy}", {
          raw,
          healthy,
        });

        const handle = await context.writeResource("throttle", "throttle", {
          raw,
          rawValue,
          now,
          sinceBoot,
          healthy,
          capturedAt,
        });
        return { dataHandles: [handle] };
      },
    },
    readClocks: {
      description:
        "Run vcgencmd measure_clock for each domain plus measure_temp and " +
        "measure_volts core, and write the clocks resource.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: MinimalLogger;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        await assertRaspberryPiHardware(context.globalArgs.vcgencmdPath);
        const capturedAt = new Date().toISOString();
        const vcgencmdPath = context.globalArgs.vcgencmdPath;

        async function runVcgencmd(...args: string[]): Promise<string> {
          const cmd = new Deno.Command(vcgencmdPath, {
            args,
            stdout: "piped",
            stderr: "piped",
          });
          const output = await cmd.output();
          if (!output.success) {
            throw new Error(
              `vcgencmd ${args.join(" ")} failed: ${
                new TextDecoder().decode(output.stderr).trim()
              }`,
            );
          }
          return new TextDecoder().decode(output.stdout);
        }

        context.logger.info("Reading clock domains: {domains}", {
          domains: CLOCK_DOMAINS.join(", "),
        });
        const clocks = await Promise.all(
          CLOCK_DOMAINS.map(async (name) => ({
            name,
            hertz: parseClockOutput(await runVcgencmd("measure_clock", name)),
          })),
        );
        const armClock = clocks.find((c) => c.name === "arm");
        if (!armClock) {
          throw new Error("arm clock domain missing from measured clocks");
        }

        const coreTempCelsius = parseTempOutput(await runVcgencmd("measure_temp"));
        const coreVolts = parseVoltsOutput(
          await runVcgencmd("measure_volts", "core"),
        );

        context.logger.info(
          "Captured clocks: armHertz={armHertz} coreTempCelsius={coreTempCelsius} coreVolts={coreVolts}",
          { armHertz: armClock.hertz, coreTempCelsius, coreVolts },
        );

        const handle = await context.writeResource("clocks", "clocks", {
          clocks,
          armHertz: armClock.hertz,
          coreTempCelsius,
          coreVolts,
          capturedAt,
        });
        return { dataHandles: [handle] };
      },
    },
    readPmic: {
      description:
        "Run vcgencmd pmic_read_adc, pair rails, and write the pmic " +
        "resource. Pi 5 only — throws a clean error on earlier models.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: MinimalLogger;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const hardware = await assertRaspberryPiHardware(
          context.globalArgs.vcgencmdPath,
        );
        assertPi5Supported(hardware);
        const capturedAt = new Date().toISOString();

        context.logger.info("Reading PMIC rails via vcgencmd pmic_read_adc");
        const cmd = new Deno.Command(context.globalArgs.vcgencmdPath, {
          args: ["pmic_read_adc"],
          stdout: "piped",
          stderr: "piped",
        });
        const output = await cmd.output();
        if (!output.success) {
          throw new Error(
            `vcgencmd pmic_read_adc failed: ${
              new TextDecoder().decode(output.stderr).trim()
            }`,
          );
        }
        const { rails, supplyVolts, batteryVolts, estimatedTotalWatts } =
          parsePmicReadAdc(new TextDecoder().decode(output.stdout));

        context.logger.info(
          "Captured {count} PMIC rails: supplyVolts={supplyVolts} estimatedTotalWatts={estimatedTotalWatts}",
          { count: rails.length, supplyVolts, estimatedTotalWatts },
        );

        const handle = await context.writeResource("pmic", "pmic", {
          rails,
          supplyVolts,
          batteryVolts,
          estimatedTotalWatts,
          capturedAt,
        });
        return { dataHandles: [handle] };
      },
    },
    readFirmware: {
      description:
        "Read model id, raw vcgencmd version, and EEPROM/bootloader status " +
        "via rpi-eeprom-update, degrading to null EEPROM fields (but still " +
        "writing model + firmwareVersion) when that command can't be read.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: MinimalLogger;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const hardware = await assertRaspberryPiHardware(
          context.globalArgs.vcgencmdPath,
        );
        const capturedAt = new Date().toISOString();

        context.logger.info("Reading firmware version via vcgencmd version");
        const versionCmd = new Deno.Command(context.globalArgs.vcgencmdPath, {
          args: ["version"],
          stdout: "piped",
          stderr: "piped",
        });
        const versionOutput = await versionCmd.output();
        if (!versionOutput.success) {
          throw new Error(
            `vcgencmd version failed: ${
              new TextDecoder().decode(versionOutput.stderr).trim()
            }`,
          );
        }
        const firmwareVersion = new TextDecoder().decode(versionOutput.stdout)
          .trim();

        context.logger.info("Reading EEPROM/bootloader status via rpi-eeprom-update");
        let eeprom: EepromInfo;
        try {
          const eepromCmd = new Deno.Command("rpi-eeprom-update", {
            args: [],
            stdout: "piped",
            stderr: "piped",
          });
          const eepromOutput = await eepromCmd.output();
          eeprom = parseEepromUpdate(
            new TextDecoder().decode(eepromOutput.stdout),
            new TextDecoder().decode(eepromOutput.stderr),
            context.logger,
          );
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            context.logger.warn(
              "rpi-eeprom-update not found on PATH; EEPROM fields will be null",
            );
            eeprom = {
              current: null,
              latest: null,
              upToDate: null,
              bootloaderVersion: null,
            };
          } else {
            throw error;
          }
        }

        if (eeprom.current === null) {
          context.logger.warn(
            "EEPROM data unavailable this run; writing firmware resource " +
              "with model and firmwareVersion only — a partial result beats no result",
          );
        }

        const handle = await context.writeResource("firmware", "firmware", {
          model: hardware.model,
          isPi5: hardware.isPi5,
          eepromCurrent: eeprom.current,
          eepromLatest: eeprom.latest,
          eepromUpToDate: eeprom.upToDate,
          bootloaderVersion: eeprom.bootloaderVersion,
          firmwareVersion,
          capturedAt,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
