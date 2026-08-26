// Run with `deno test -A`. See host_health_test.ts for why -A is needed
// (procfs reads via `cat` trip Deno's permission checker without it) — same
// quirk applies here since assertRaspberryPiHardware reads /proc via `cat`.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { parseThrottled } from "./rpi_health.ts";

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
