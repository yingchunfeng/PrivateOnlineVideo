import test from "node:test";
import assert from "node:assert/strict";
import { SpaceMeteorEngine } from "../src/space-meteor-engine";
import { DEFAULT_SPACE_SETTINGS, detectSpaceDevice, effectiveSpaceSettings, normalizeSpaceSettings, readSpaceSettings } from "../src/space-meteor-settings";
import type { SpaceEffectsSettings } from "../src/space-meteor-settings";

function settings(patch: Partial<SpaceEffectsSettings["shower"]> = {}) {
  const value = normalizeSpaceSettings(DEFAULT_SPACE_SETTINGS);
  value.normal.intervalMin = value.normal.intervalMax = 1;
  value.shower = { ...value.shower, ...patch };
  return value;
}
function seeded() { let value = 17; return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 2 ** 32; }; }
function ready(value: SpaceEffectsSettings, random: () => number = seeded()) {
  const engine = new SpaceMeteorEngine(random, value);
  engine.setSafety({ allowed: true, input: false }, 0);
  return engine;
}

test("meteor configuration rejects corruption, NaN, empty values and inverted ranges without sharing defaults", () => {
  const result = normalizeSpaceSettings({ normal: { batchMin: 10, batchMax: 2, maxVisible: -6, intervalMin: NaN, intervalMax: "", sizeMin: 200, sizeMax: -1, colors: ["bad"], durationMin: null, foregroundRatio: Infinity }, shower: { probability: 500, duration: -2, cooldown: -4 } });
  assert.equal(result.normal.batchMin, 2); assert.equal(result.normal.batchMax, 10);
  assert.equal(result.normal.maxVisible, 1); assert.equal(result.normal.intervalMin, .6); assert.equal(result.normal.intervalMax, 1.8);
  assert.equal(result.normal.sizeMin, .2); assert.equal(result.normal.sizeMax, 4);
  assert.equal(result.normal.durationMin, 1.2); assert.equal(result.normal.foregroundRatio, 20);
  assert.deepEqual(result.normal.colors, DEFAULT_SPACE_SETTINGS.normal.colors);
  assert.equal(result.shower.probability, 100); assert.equal(result.shower.duration, 1); assert.equal(result.shower.cooldown, 5);
  result.normal.colors.pop(); assert.equal(DEFAULT_SPACE_SETTINGS.normal.colors.length, 5);
  assert.deepEqual(readSpaceSettings({ getItem: () => "{broken" }), normalizeSpaceSettings(null));
  assert.deepEqual(readSpaceSettings({ getItem: () => { throw new Error("denied"); } }), normalizeSpaceSettings(null));
});

test("device hard limits constrain both modes and mobile always disables foreground", () => {
  const input = normalizeSpaceSettings({ normal: { maxVisible: 48, intervalMin: .1, intervalMax: .1, sizeMin: 3, sizeMax: 4 }, shower: { maxVisible: 48 } });
  const phone = detectSpaceDevice(375); const mobile = effectiveSpaceSettings(input, phone);
  assert.equal(mobile.normal.maxVisible, 4); assert.equal(mobile.shower.maxVisible, 8);
  const oversizedBatch = effectiveSpaceSettings(normalizeSpaceSettings({ normal: { batchMin: 24, batchMax: 24, maxVisible: 3 } }), phone);
  assert.equal(oversizedBatch.normal.batchMin, 3); assert.equal(oversizedBatch.normal.batchMax, 3);
  assert.equal(mobile.normal.intervalMin, .35); assert.equal(mobile.normal.intervalMax, .35);
  assert.equal(mobile.normal.sizeMin, 1.5); assert.equal(mobile.normal.sizeMax, 1.5);
  assert.equal(mobile.normal.foreground, false); assert.equal(mobile.shower.foreground, false);
  assert.equal(detectSpaceDevice(1440, 4).hardLimit, 16);
  assert.equal(detectSpaceDevice(1440, 12, 16).hardLimit, 48);
});

test("probability zero never triggers; probability 100 triggers on the first eligible opportunity", () => {
  const zero = ready(settings({ probability: 0 }), () => 0);
  for (let now = 1000; now <= 120000; now += 1000) assert.equal(zero.tick(now).shower, false);
  const certain = ready(settings({ probability: 100 }), () => .999);
  assert.equal(certain.tick(999).shower, false);
  assert.equal(certain.tick(1000).shower, true);
});

test("automatic probability is sampled once per eligible normal emission, not per tick/frame or while typing", () => {
  let calls = 0;
  const engine = ready(settings({ probability: 100 }), () => { calls++; return .5; });
  const before = calls;
  for (let now = 1; now < 1000; now++) engine.tick(now);
  assert.equal(calls, before);
  engine.setSafety({ allowed: true, input: true }, 1000);
  assert.equal(engine.tick(1000).shower, false);
  engine.setSafety({ allowed: true, input: false }, 1001);
  assert.equal(engine.tick(1999).shower, false);
  assert.equal(engine.tick(2000).shower, true);
});

test("duration and cooldown are exact, 100 percent cannot bypass cooldown, and active showers never overlap", () => {
  const engine = ready(settings({ probability: 100, duration: 2, cooldown: 5 }), () => 0);
  assert.equal(engine.tick(1000).shower, true);
  for (let now = 1100; now < 3000; now += 100) assert.equal(engine.tick(now).shower, true);
  assert.equal(engine.tick(3000).shower, false);
  for (let now = 4000; now < 8000; now += 1000) assert.equal(engine.tick(now).shower, false);
  assert.equal(engine.tick(8000).shower, true);
});

test("ordinary batch bounds, minimum start interval and combined foreground/background concurrency are enforced", () => {
  const value = settings({ probability: 0 });
  value.normal = { ...value.normal, batchMin: 2, batchMax: 3, maxVisible: 5, durationMin: 8, durationMax: 8, foregroundRatio: 50 };
  const engine = ready(value, () => .5);
  const first = engine.tick(1000); assert.equal(first.meteors.length, 3);
  assert.equal(engine.tick(1999).meteors.length, 3);
  assert.equal(engine.tick(2000).meteors.length, 5);
  assert.equal(engine.tick(3000).meteors.length, 5);
  const rain = ready(settings({ probability: 100, batchMin: 24, batchMax: 24, maxVisible: 7, intervalMin: .1, intervalMax: .1 }), () => .5);
  for (let now = 1000; now < 5000; now += 100) assert.ok(rain.tick(now).meteors.length <= 7);
});

test("independent sizes, colors, durations and routes vary, and resizing does not scale or alter the path", () => {
  const value = settings({ probability: 0 });
  value.normal.batchMin = value.normal.batchMax = 6; value.normal.maxVisible = 6;
  const a = ready(value); const first = a.tick(1000).meteors;
  assert.equal(first.length, 6);
  assert.ok(new Set(first.map(meteor => meteor.size)).size > 1);
  assert.ok(new Set(first.map(meteor => meteor.duration)).size > 1);
  assert.ok(new Set(first.map(meteor => meteor.x)).size > 1);
  assert.ok(new Set(first.map(meteor => meteor.color)).size > 1);
  assert.ok(first.some(meteor => meteor.tail !== meteor.color));
  const large = normalizeSpaceSettings(value); large.normal.sizeMin = 3; large.normal.sizeMax = 4;
  const second = ready(large).tick(1000).meteors;
  assert.notEqual(first[0]!.size, second[0]!.size);
  assert.deepEqual(first.map(({ x, y, dx, dy, angle }) => ({ x, y, dx, dy, angle })), second.map(({ x, y, dx, dy, angle }) => ({ x, y, dx, dy, angle })));
});

test("preview bypasses probability and cooldown only, cannot stack, can switch modes, and never bypasses safety", () => {
  const engine = ready(settings({ probability: 0, enabled: false, duration: 2 }), () => 0);
  assert.equal(engine.preview("shower", 100), true);
  const first = engine.tick(100); assert.equal(first.shower, true); assert.equal(first.previewMode, "shower");
  assert.equal(engine.preview("shower", 500), false);
  assert.equal(engine.tick(2100).shower, false);
  assert.equal(engine.preview("shower", 2200), true);
  assert.equal(engine.preview("normal", 2300), true);
  assert.equal(engine.tick(2300).shower, false); assert.equal(engine.snapshot().previewMode, "normal");
  engine.stopPreview(2400); assert.equal(engine.snapshot().meteors.length, 0); assert.equal(engine.snapshot().previewMode, null);
  engine.setSafety({ allowed: false, input: false }, 2500);
  assert.equal(engine.preview("shower", 2600), false); assert.equal(engine.tick(5000).meteors.length, 0);
});

test("suspension clears particles and preview immediately; resuming schedules fresh rather than replaying backlog", () => {
  const engine = ready(settings({ probability: 0 }));
  engine.tick(1000); assert.ok(engine.snapshot().meteors.length > 0);
  engine.setSafety({ allowed: false, input: false }, 1100);
  assert.equal(engine.snapshot().meteors.length, 0); assert.equal(engine.snapshot().nextAt, Infinity);
  engine.setSafety({ allowed: true, input: false }, 100000);
  assert.equal(engine.tick(100000).meteors.length, 0);
  assert.equal(engine.tick(100999).meteors.length, 0);
  assert.ok(engine.tick(101000).meteors.length > 0);
});

test("shower ramps from sparse to rich, tapers before ending, then lets particles leave naturally", () => {
  const value = settings({ probability: 0, batchMin: 2, batchMax: 6, maxVisible: 48, intervalMin: .2, intervalMax: .2, duration: 8, durationMin: .5, durationMax: .5 });
  const engine = ready(value, () => .999); engine.preview("shower", 0);
  assert.equal(engine.tick(0).meteors.length, 3);
  engine.tick(200); engine.tick(400); engine.tick(600); engine.tick(800); engine.tick(1000);
  const peak = engine.tick(1600).meteors.filter(meteor => meteor.born === 1600).length;
  const taper = engine.tick(7800).meteors.filter(meteor => meteor.born === 7800).length;
  assert.equal(peak, 6); assert.equal(taper, 3);
  const ended = engine.tick(8000); assert.equal(ended.shower, false); assert.ok(ended.meteors.length > 0);
  assert.equal(engine.tick(8400).meteors.length, 0);
});

test("a batch never falls below its configured minimum, including rain ramps and nearly-full screens", () => {
  const value = settings({ probability: 0 });
  value.normal = { ...value.normal, batchMin: 3, batchMax: 3, maxVisible: 4, durationMin: 8, durationMax: 8 };
  const normal = ready(value, () => .5);
  assert.equal(normal.tick(1000).meteors.length, 3);
  assert.equal(normal.tick(2000).meteors.length, 3);
  const rain = ready(settings({ probability: 0, batchMin: 4, batchMax: 6, maxVisible: 9, intervalMin: .2, intervalMax: .2, durationMin: 4, durationMax: 4 }), () => .5);
  rain.preview("shower", 0);
  let previous = 0;
  for (let now = 0; now < 3000; now += 200) {
    const current = rain.tick(now).meteors.length;
    const batch = current - previous;
    assert.ok(batch === 0 || batch >= 4 && batch <= 6);
    previous = current;
  }
});

test("configuration updates and long timer delays never accumulate missed batches or reset meteor identity", () => {
  const value = settings({ probability: 0 }); value.normal.batchMin = value.normal.batchMax = 2;
  const engine = ready(value, () => .5);
  const original = engine.tick(1000).meteors[0]!;
  engine.configure(value, detectSpaceDevice(1440), 1200);
  assert.equal(engine.snapshot().meteors[0]!.id, original.id);
  assert.equal(engine.tick(2199).meteors.length, 2);
  const delayed = engine.tick(50000).meteors;
  assert.equal(delayed.length, 2); assert.ok(delayed.every(meteor => meteor.born === 50000));
});

test("rain drains naturally before normal resumes, so the normal phase always meets its smaller cap", () => {
  const value = settings({ probability: 0, duration: 2, batchMin: 12, batchMax: 12, maxVisible: 24, intervalMin: .1, intervalMax: .1, durationMin: 4, durationMax: 4 });
  value.normal.maxVisible = 2;
  const engine = ready(value, () => .5); engine.preview("shower", 0);
  for (let now = 0; now < 2000; now += 100) engine.tick(now);
  const end = engine.tick(2000);
  assert.equal(end.shower, false); assert.equal(end.draining, true); assert.ok(end.meteors.length > 2);
  for (let now = 2100; now < 6000; now += 100) {
    const phase = engine.tick(now);
    if (phase.draining) assert.ok(phase.meteors.every(meteor => meteor.mode === "shower"));
    else assert.ok(phase.meteors.length <= 2);
  }
  assert.equal(engine.tick(6000).draining, false);
  assert.ok(engine.tick(7000).meteors.length <= 2);
});

test("entering a lower-cap automatic shower trims already-flying normal meteors to the rain cap", () => {
  const value = settings({ probability: 0, maxVisible: 1, batchMin: 1, batchMax: 1, duration: 1 });
  value.normal = { ...value.normal, batchMin: 24, batchMax: 24, maxVisible: 48, durationMin: 8, durationMax: 8 };
  const engine = ready(value, () => .5);
  assert.equal(engine.tick(1000).meteors.length, 24);
  assert.equal(engine.tick(2000).meteors.length, 48);
  value.shower.probability = 100;
  engine.configure(value, detectSpaceDevice(1440), 2100);
  const rain = engine.tick(3100);
  assert.equal(rain.shower, true);
  assert.ok(rain.meteors.length <= 1);
});

test("returning from rain enforces a newly-lowered normal cap even for long-lived old normal particles", () => {
  const value = settings({ probability: 0, duration: 2, maxVisible: 24, batchMin: 2, batchMax: 2, intervalMin: .2, intervalMax: .2, durationMin: 1, durationMax: 1 });
  value.normal = { ...value.normal, batchMin: 4, batchMax: 4, maxVisible: 8, durationMin: 8, durationMax: 8 };
  const engine = ready(value, () => .5);
  assert.equal(engine.tick(1000).meteors.length, 4);
  value.shower.probability = 100;
  engine.configure(value, detectSpaceDevice(1440), 1100);
  assert.equal(engine.tick(2100).shower, true);
  engine.tick(2300);
  value.normal.maxVisible = 1;
  engine.configure(value, detectSpaceDevice(1440), 2400);
  for (let now = 2600; now <= 5500; now += 100) {
    const phase = engine.tick(now);
    if (!phase.shower && !phase.draining) assert.ok(phase.meteors.length <= 1);
  }
  const normal = engine.tick(5600);
  assert.equal(normal.shower, false); assert.equal(normal.draining, false);
  assert.ok(normal.meteors.length <= 1);
});

test("live duration edits update an active shower and preview deadline without changing generated flight parameters", () => {
  const value = settings({ probability: 0, duration: 8, durationMin: 4, durationMax: 4 });
  const engine = ready(value, () => .5);
  engine.preview("shower", 0);
  const particle = engine.tick(0).meteors[0]!;
  value.shower.duration = 1;
  engine.configure(value, detectSpaceDevice(1440), 1500);
  assert.equal(engine.snapshot().meteors[0]!.expires, particle.expires);
  assert.equal(engine.snapshot().meteors[0]!.duration, particle.duration);
  assert.equal(engine.snapshot().meteors[0]!.dx, particle.dx);
  const shortened = engine.tick(1500);
  assert.equal(shortened.shower, false); assert.equal(shortened.previewMode, null); assert.equal(shortened.draining, true);

  const extended = ready(settings({ probability: 0, duration: 2 }), () => .5);
  extended.preview("shower", 0); extended.tick(0);
  const longer = settings({ probability: 0, duration: 6 });
  extended.configure(longer, detectSpaceDevice(1440), 1000);
  assert.equal(extended.tick(2000).shower, true);
  assert.equal(extended.tick(5999).previewMode, "shower");
  assert.equal(extended.preview("shower", 5999), false);
  assert.equal(extended.tick(6000).shower, false);
  assert.equal(extended.snapshot().previewMode, null);
});

test("live cooldown edits apply from the saved end instant, including shorter and longer cooldowns", () => {
  const value = settings({ probability: 100, duration: 1, cooldown: 60, durationMin: .5, durationMax: .5 });
  const engine = ready(value, () => .5);
  assert.equal(engine.tick(1000).shower, true);
  assert.equal(engine.tick(2000).shower, false);
  value.shower.cooldown = 5;
  engine.configure(value, detectSpaceDevice(1440), 3000);
  for (let now = 4000; now < 7000; now += 1000) assert.equal(engine.tick(now).shower, false);
  assert.equal(engine.tick(7000).shower, true);

  const longer = ready(settings({ probability: 100, duration: 1, cooldown: 5, durationMin: .5, durationMax: .5 }), () => .5);
  longer.tick(1000); longer.tick(2000);
  longer.configure(settings({ probability: 100, duration: 1, cooldown: 60 }), detectSpaceDevice(1440), 3000);
  assert.equal(longer.tick(7000).shower, false);
  assert.equal(longer.tick(62000).shower, true);
});

test("disabling a mode foreground removes only that mode's in-flight foreground immediately", () => {
  const value = settings({ probability: 0, foregroundRatio: 100 });
  value.normal.foregroundRatio = 100;
  const engine = ready(value, () => .5);
  assert.ok(engine.tick(1000).meteors.every(meteor => meteor.layer === "foreground"));
  value.normal.foreground = false;
  engine.configure(value, detectSpaceDevice(1440), 1100);
  assert.equal(engine.snapshot().meteors.length, 0);
  engine.preview("shower", 1200);
  const rain = engine.tick(1200); assert.ok(rain.meteors.length > 0 && rain.meteors.every(meteor => meteor.layer === "foreground"));
  value.shower.foreground = false;
  engine.configure(value, detectSpaceDevice(1440), 1300);
  assert.equal(engine.snapshot().meteors.length, 0);
});
