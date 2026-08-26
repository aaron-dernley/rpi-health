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
  },
};
