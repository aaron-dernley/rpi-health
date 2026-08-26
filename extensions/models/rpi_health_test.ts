// Run with `deno test -A`. See host_health_test.ts for why -A is needed
// (procfs reads via `cat` trip Deno's permission checker without it) — same
// quirk applies here since assertRaspberryPiHardware reads /proc via `cat`.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260824.32";
import {
  assertPi5Supported,
  model,
  parseClockOutput,
  parsePmicReadAdc,
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

// --- parsePmicReadAdc -----------------------------------------------------

// Captured live from `vcgencmd pmic_read_adc` on this Pi 5, unprivileged.
const REAL_PMIC_OUTPUT = `
 3V7_WL_SW_A current(0)=0.08880963A
   3V3_SYS_A current(1)=0.06636324A
   1V8_SYS_A current(2)=0.17371550A
  DDR_VDD2_A current(3)=0.01463895A
  DDR_VDDQ_A current(4)=0.00000000A
   1V1_SYS_A current(5)=0.22641580A
    0V8_SW_A current(6)=0.26838080A
  VDD_CORE_A current(7)=0.92871990A
   3V3_DAC_A current(17)=0.00012210A
   3V3_ADC_A current(18)=0.00024420A
   0V8_AON_A current(16)=0.00341880A
      HDMI_A current(22)=0.02344320A
 3V7_WL_SW_V volt(8)=3.65987400V
   3V3_SYS_V volt(9)=3.30632200V
   1V8_SYS_V volt(10)=1.79682400V
  DDR_VDD2_V volt(11)=1.10292900V
  DDR_VDDQ_V volt(12)=0.60219720V
   1V1_SYS_V volt(13)=1.10402800V
    0V8_SW_V volt(14)=0.80109810V
  VDD_CORE_V volt(15)=0.90901010V
   3V3_DAC_V volt(20)=3.30311000V
   3V3_ADC_V volt(21)=3.30127900V
   0V8_AON_V volt(19)=0.79618980V
      HDMI_V volt(23)=5.08530000V
     EXT5V_V volt(24)=5.08798000V
      BATT_V volt(25)=0.00256410V
`;

Deno.test("parsePmicReadAdc pairs 3V7_WL_SW correctly despite the embedded 'V' in its name", () => {
  const result = parsePmicReadAdc(REAL_PMIC_OUTPUT);
  const rail = result.rails.find((r) => r.name === "3V7_WL_SW");
  assert(rail, "3V7_WL_SW rail missing");
  assertEquals(rail.amps, 0.08880963);
  assertEquals(rail.volts, 3.659874);
  assertEquals(rail.watts, 0.08880963 * 3.659874);
});

Deno.test("parsePmicReadAdc hoists EXT5V_V and BATT_V without leaving orphan rail entries", () => {
  const result = parsePmicReadAdc(REAL_PMIC_OUTPUT);
  assertEquals(result.supplyVolts, 5.08798);
  assertEquals(result.batteryVolts, 0.0025641);
  assert(
    !result.rails.some((r) => r.name === "EXT5V" || r.name === "BATT"),
    "EXT5V/BATT leaked into rails as orphan entries",
  );
});

Deno.test("parsePmicReadAdc pairs every current/voltage rail with no nulls on real output", () => {
  const result = parsePmicReadAdc(REAL_PMIC_OUTPUT);
  // 12 current entries + 12 matched voltage entries = 12 fully-paired rails
  // (EXT5V/BATT are the 2 remaining voltage-only entries, hoisted above).
  assertEquals(result.rails.length, 12);
  for (const rail of result.rails) {
    assert(rail.volts !== null, `${rail.name} missing volts`);
    assert(rail.amps !== null, `${rail.name} missing amps`);
    assert(rail.watts !== null, `${rail.name} missing watts`);
  }
});

Deno.test("parsePmicReadAdc estimatedTotalWatts lands in the plausible idle range with real output", () => {
  const result = parsePmicReadAdc(REAL_PMIC_OUTPUT);
  assert(
    result.estimatedTotalWatts > 1.5 && result.estimatedTotalWatts < 4,
    `estimatedTotalWatts ${result.estimatedTotalWatts} outside plausible idle range`,
  );
});

Deno.test("parsePmicReadAdc handles single-line whitespace-separated input, not just one-per-line", () => {
  const oneLine =
    "3V3_SYS_A current(1)=0.06050766A 3V3_SYS_V volt(9)=3.32766400V EXT5V_V volt(24)=5.17776000V";
  const result = parsePmicReadAdc(oneLine);
  assertEquals(result.rails, [
    { name: "3V3_SYS", amps: 0.06050766, volts: 3.327664, watts: 0.06050766 * 3.327664 },
  ]);
  assertEquals(result.supplyVolts, 5.17776);
});

Deno.test("parsePmicReadAdc null-fills a rail with only a current entry rather than defaulting to zero", () => {
  const result = parsePmicReadAdc("SOME_RAIL_A current(0)=0.5A");
  assertEquals(result.rails, [
    { name: "SOME_RAIL", amps: 0.5, volts: null, watts: null },
  ]);
});

Deno.test("parsePmicReadAdc throws on a label with no _A/_V suffix", () => {
  assertThrows(
    () => parsePmicReadAdc("BOGUS_LABEL current(0)=0.5A"),
    Error,
    "expected _A/_V suffix",
  );
});

Deno.test("assertPi5Supported throws a clean unsupported-model error for a non-Pi5 model string", () => {
  assertThrows(
    () => assertPi5Supported({ model: "Raspberry Pi 4 Model B Rev 1.4", isPi5: false }),
    Error,
    "unsupported on this model",
  );
});

Deno.test("assertPi5Supported does not throw for a Pi 5 model string", () => {
  assertPi5Supported({ model: "Raspberry Pi 5 Model B Rev 1.1", isPi5: true });
});

Deno.test("readPmic writes a pmic resource with sane invariants on this real Pi 5", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { vcgencmdPath: "vcgencmd" },
    methodName: "readPmic",
  });

  await model.methods.readPmic.execute({}, asContext(context));

  const data = getWrittenResources()[0].data as {
    rails: Array<{ name: string }>;
    supplyVolts: number | null;
    estimatedTotalWatts: number;
  };
  assert(data.rails.length > 0);
  assert(data.supplyVolts !== null && data.supplyVolts > 4.5 && data.supplyVolts < 5.5);
  assert(data.estimatedTotalWatts > 0);
});
