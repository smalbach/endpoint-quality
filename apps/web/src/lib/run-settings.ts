/**
 * How a flow is executed — kept apart from what it tests.
 *
 * A flow is the same flow whether it runs flat out or one node at a time; these settings change the
 * rhythm, where it stops for a person and when it gives up, never an assertion. That is why they
 * live beside the flow in this browser rather than inside its saved definition: two people watching
 * the same flow at different speeds are not two versions of it.
 */

export type PauseMode = "none" | "step" | "breakpoints";

export type RunSettings = {
  /** `step` waits before every node; `breakpoints` only before the marked ones. */
  pauseMode: PauseMode;
  /** Node ids to stop before, in `breakpoints` mode. */
  breakpoints: string[];
  /** Pause between dispatches, in ms. The target's rate limit is what it is for. */
  delayMs: number;
  /** Nodes in flight at once. Only independent ones ever run together. */
  concurrency: number;
  /** The first failing node ends the run; what had not run is marked skipped. */
  stopOnFailure: boolean;
};

export const DEFAULT_RUN_SETTINGS: RunSettings = {
  pauseMode: "none",
  breakpoints: [],
  delayMs: 0,
  concurrency: 1,
  stopOnFailure: false,
};

export const DELAY_LIMIT_MS = 30_000;
export const CONCURRENCY_LIMIT = 10;

/** The presets the pause field offers; any other value is typed by hand. */
export const DELAY_PRESETS = [
  { label: "Sin pausa", value: 0 },
  { label: "300 ms", value: 300 },
  { label: "1 s", value: 1000 },
  { label: "2,5 s", value: 2500 },
] as const;

/**
 * Settings as the server will accept them, whatever was stored.
 *
 * Read back from `localStorage`, which another version of this screen may have written — or a
 * person, by hand. A number out of range becomes the nearest one in range, a mode nobody knows
 * becomes `none`, and breakpoints on nodes the flow no longer has are dropped, so launching never
 * fails on a setting the screen cannot show.
 */
export function normalizeRunSettings(value: unknown, stepIds?: readonly string[]): RunSettings {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof RunSettings, unknown>>;
  const pauseMode: PauseMode =
    raw.pauseMode === "step" || raw.pauseMode === "breakpoints" ? raw.pauseMode : "none";
  const known = stepIds ? new Set(stepIds) : null;
  const breakpoints = Array.isArray(raw.breakpoints)
    ? [...new Set(raw.breakpoints.filter((id): id is string => typeof id === "string" && (!known || known.has(id))))]
    : [];
  return {
    pauseMode,
    breakpoints,
    delayMs: clampInt(raw.delayMs, 0, DELAY_LIMIT_MS, 0),
    concurrency: clampInt(raw.concurrency, 1, CONCURRENCY_LIMIT, 1),
    stopOnFailure: raw.stopOnFailure === true,
  };
}

/**
 * The run body fields these settings contribute.
 *
 * Only what differs from the server's own default is sent, so a run launched with nothing changed
 * is byte for byte the run this screen always launched. `breakpoints` mode with no node marked is
 * sent as it is and refused by the server with a message naming the field — {@link runSettingsProblem}
 * is what keeps the button from getting there.
 */
export function runSettingsBody(settings: RunSettings): {
  delayMs: number;
  concurrency: number;
  pauseMode?: Exclude<PauseMode, "none">;
  breakpoints?: string[];
  stopOnFailure?: true;
} {
  return {
    delayMs: settings.delayMs,
    concurrency: settings.concurrency,
    ...(settings.pauseMode !== "none" ? { pauseMode: settings.pauseMode } : {}),
    ...(settings.pauseMode === "breakpoints" ? { breakpoints: settings.breakpoints } : {}),
    ...(settings.stopOnFailure ? { stopOnFailure: true as const } : {}),
  };
}

/** Why these settings cannot launch a run, or null when they can. */
export function runSettingsProblem(settings: RunSettings): string | null {
  if (settings.pauseMode === "breakpoints" && settings.breakpoints.length === 0) {
    return "Marca al menos un nodo donde detenerse";
  }
  return null;
}

/** A few words for the chip beside «Ejecutar», or null when everything is at its default. */
export function runSettingsSummary(settings: RunSettings): string | null {
  const parts: string[] = [];
  if (settings.pauseMode === "step") parts.push("Paso a paso");
  if (settings.pauseMode === "breakpoints") {
    parts.push(`${settings.breakpoints.length} ${settings.breakpoints.length === 1 ? "parada" : "paradas"}`);
  }
  if (settings.delayMs > 0) parts.push(settings.delayMs >= 1000 ? `${settings.delayMs / 1000} s` : `${settings.delayMs} ms`);
  if (settings.concurrency > 1) parts.push(`×${settings.concurrency}`);
  if (settings.stopOnFailure) parts.push("para al fallar");
  return parts.length ? parts.join(" · ") : null;
}

const storageKey = (flowId: string) => `eq.run-settings.${flowId}`;

/** This browser's settings for a flow. Storage can be missing or refuse (a private window), and
 * then the defaults are the answer rather than an error. */
export function loadRunSettings(flowId: string, stepIds?: readonly string[]): RunSettings {
  try {
    const raw = window.localStorage.getItem(storageKey(flowId));
    return normalizeRunSettings(raw ? JSON.parse(raw) : null, stepIds);
  } catch {
    return { ...DEFAULT_RUN_SETTINGS };
  }
}

export function saveRunSettings(flowId: string, settings: RunSettings): void {
  try {
    window.localStorage.setItem(storageKey(flowId), JSON.stringify(settings));
  } catch {
    // Not remembered next time; this run still uses them.
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}
