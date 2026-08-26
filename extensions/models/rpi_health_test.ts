// Run with `deno test -A`. See host_health_test.ts for why -A is needed
// (procfs reads via `cat` trip Deno's permission checker without it) — same
// quirk applies here since assertRaspberryPiHardware reads /proc via `cat`.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260824.32";
import {
  model,
  parseClockOutput,
  parseTempOutput,
  parseThrottled,
  parseVoltsOutput,
} from "./rpi_health.ts";

// createModelTestContext() returns a MethodContext typed with a default
// Record<string, unknown> globalArgs — narrower than each execute()'s own
// inline context type. This cast bridges that gap; the contextual type at
// each call site (inferred from execute()'s own parameter type) fills in T.
function asContext<T>(context: unknown): T {
  return context as T;
}

// --- parseThrottled -----------------------------------------------------

Deno.test("parseThrottled: 0x0 is fully healthy", () => {
  const result = parseThrottled("throttled=0x0");
  assertEquals(result.raw, "0x0");
  assertEquals(result.rawValue, 0);
  assertEquals(result.healthy, true);
  assertEquals(result.now, {
    underVoltage: false,
    armFrequencyCapped: false,
    throttled: false,
    softTempLimitActive: false,
  });
  assertEquals(result.sinceBoot, {
    underVoltage: false,
    armFrequencyCapped: false,
    throttled: false,
    softTempLimitReached: false,
  });
});

Deno.test("parseThrottled: 0x50000 sets only sticky underVoltage and throttled", () => {
  const result = parseThrottled("throttled=0x50000");
  assertEquals(result.rawValue, 0x50000);
  assertEquals(result.healthy, false);
  assertEquals(result.now, {
    underVoltage: false,
    armFrequencyCapped: false,
    throttled: false,
    softTempLimitActive: false,
  });
  assertEquals(result.sinceBoot, {
    underVoltage: true,
    armFrequencyCapped: false,
    throttled: true,
    softTempLimitReached: false,
  });
});

Deno.test("parseThrottled: bit 0 sets only now.underVoltage", () => {
  const result = parseThrottled("throttled=0x1");
  assertEquals(result.now.underVoltage, true);
  assertEquals(result.now.armFrequencyCapped, false);
  assertEquals(result.now.throttled, false);
  assertEquals(result.now.softTempLimitActive, false);
  assert(!result.sinceBoot.underVoltage);
});

Deno.test("parseThrottled: all now+sinceBoot bits set (0xF000F)", () => {
  const result = parseThrottled("throttled=0xf000f");
  assertEquals(result.now, {
    underVoltage: true,
    armFrequencyCapped: true,
    throttled: true,
    softTempLimitActive: true,
  });
  assertEquals(result.sinceBoot, {
    underVoltage: true,
    armFrequencyCapped: true,
    throttled: true,
    softTempLimitReached: true,
  });
  assertEquals(result.healthy, false);
});

Deno.test("parseThrottled: tolerates trailing whitespace/newline", () => {
  const result = parseThrottled("throttled=0x50000\n");
  assertEquals(result.raw, "0x50000");
});

Deno.test("parseThrottled: throws on unparseable input rather than silently returning zero", () => {
  assertThrows(
    () => parseThrottled("not the expected format"),
    Error,
    "Unexpected vcgencmd get_throttled output",
  );
});

// --- parseClockOutput / parseTempOutput / parseVoltsOutput --------------

Deno.test("parseClockOutput parses a typical measure_clock line", () => {
  assertEquals(parseClockOutput("frequency(0)=2400020480"), 2400020480);
  assertEquals(parseClockOutput("frequency(48)=910007424\n"), 910007424);
});

Deno.test("parseClockOutput throws on unparseable input", () => {
  assertThrows(
    () => parseClockOutput("garbage"),
    Error,
    "Unexpected vcgencmd measure_clock output",
  );
});

Deno.test("parseTempOutput parses a typical measure_temp line", () => {
  assertEquals(parseTempOutput("temp=58.2'C\n"), 58.2);
});

Deno.test("parseTempOutput throws on unparseable input", () => {
  assertThrows(
    () => parseTempOutput("temp=oops"),
    Error,
    "Unexpected vcgencmd measure_temp output",
  );
});

Deno.test("parseVoltsOutput parses a typical measure_volts line", () => {
  assertEquals(parseVoltsOutput("volt=0.9053V\n"), 0.9053);
});

Deno.test("parseVoltsOutput throws on unparseable input", () => {
  assertThrows(
    () => parseVoltsOutput("volt=oops"),
    Error,
    "Unexpected vcgencmd measure_volts output",
  );
});

// --- Method-level tests against real vcgencmd on this Pi 5 --------------
//
// This model refuses to run at all off Pi hardware, so — like
// @aaronge/host-health's method-level tests against real /proc and /sys —
// these exercise the real vcgencmd on whatever host runs the suite, and
// assert invariants (types, ranges) rather than exact values.

Deno.test("readThrottle writes a throttle resource from real vcgencmd output", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { vcgencmdPath: "vcgencmd" },
    methodName: "readThrottle",
  });

  await model.methods.readThrottle.execute({}, asContext(context));

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "throttle");
  const data = written[0].data as { raw: string; healthy: boolean; capturedAt: string };
  assert(data.raw.startsWith("0x"));
  assertEquals(typeof data.healthy, "boolean");
  assert(typeof data.capturedAt === "string");
});

Deno.test("readClocks writes a clocks resource with sane invariants", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { vcgencmdPath: "vcgencmd" },
    methodName: "readClocks",
  });

  await model.methods.readClocks.execute({}, asContext(context));

  const data = getWrittenResources()[0].data as {
    clocks: Array<{ name: string; hertz: number }>;
    armHertz: number;
    coreTempCelsius: number;
    coreVolts: number;
  };
  assertEquals(data.clocks.length, 5);
  assert(data.armHertz > 0);
  assert(data.coreTempCelsius > -50 && data.coreTempCelsius < 150);
  assert(data.coreVolts > 0 && data.coreVolts < 5);
  const armEntry = data.clocks.find((c) => c.name === "arm");
  assertEquals(armEntry?.hertz, data.armHertz);
});
