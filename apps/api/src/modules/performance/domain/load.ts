/**
 * The load, as a function of time — the pure half the executor asks «how many now».
 *
 * Kept here, with no clock and no I/O, because a ramp that is right is a small piece of arithmetic
 * and a ramp that is wrong wastes a two-minute run to find out. Tested with elapsed seconds in and
 * a virtual-user count out, no waiting.
 */
import type { LoadProfile, PerformanceScenario } from "./model";

/** How long the whole run lasts, whatever its shape. */
export function totalDurationS(profile: LoadProfile): number {
  return Math.max(1, Math.trunc(profile.durationS));
}

/** The largest number of virtual users the profile ever asks for — what the executor pre-allocates. */
export function peakVus(profile: LoadProfile): number {
  switch (profile.type) {
    case "constant":
      return Math.max(1, profile.vus);
    case "ramp":
      return Math.max(1, profile.startVus, profile.endVus);
    case "spike":
      return Math.max(1, profile.baseVus, profile.peakVus);
  }
}

/**
 * The target number of active virtual users at `elapsedS` seconds into the run.
 *
 * `ramp` is linear between its ends; `spike` sits at base, jumps to peak for the middle third, and
 * drops back — the shape that reproduces a surge rather than a slow climb. Outside `[0, duration]`
 * it clamps to the nearest end, so a scheduler that overshoots the clock by a tick reads a sane
 * number instead of extrapolating past the run.
 */
export function activeVusAt(profile: LoadProfile, elapsedS: number): number {
  const duration = totalDurationS(profile);
  const t = Math.min(Math.max(elapsedS, 0), duration);
  switch (profile.type) {
    case "constant":
      return Math.max(1, profile.vus);
    case "ramp": {
      const fraction = duration === 0 ? 1 : t / duration;
      return Math.max(1, Math.round(profile.startVus + (profile.endVus - profile.startVus) * fraction));
    }
    case "spike": {
      const third = duration / 3;
      const inPeak = t >= third && t < third * 2;
      return Math.max(1, inPeak ? profile.peakVus : profile.baseVus);
    }
  }
}

/**
 * Pick a scenario by weight, given a number in `[0, 1)`.
 *
 * The `random` is passed in rather than taken from `Math.random`, so the choice is testable and the
 * executor stays the only place that decides what «random» means at runtime. A plan with no positive
 * weights falls back to the first scenario — a weight of zero is «never», and all-zero is a plan
 * that would otherwise pick nothing and do nothing.
 */
export function pickScenario(scenarios: PerformanceScenario[], random: number): PerformanceScenario | undefined {
  if (!scenarios.length) return undefined;
  const weights = scenarios.map((scenario) => Math.max(0, scenario.weight));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return scenarios[0];
  let cursor = Math.min(Math.max(random, 0), 0.999999) * total;
  for (let index = 0; index < scenarios.length; index += 1) {
    cursor -= weights[index];
    if (cursor < 0) return scenarios[index];
  }
  return scenarios[scenarios.length - 1];
}
