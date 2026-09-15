/**
 * A paused run, as the flow canvas draws it: which node it is waiting before, and where a person
 * asked it to stop.
 */
import type { RunSettings } from "@/lib/run-settings";

/** Where a waiting run stopped, as `GET /runs/:id` and the stream's `paused` event say it. */
export type RunPausePosition = { caseId: string; stepId: string | null };

/**
 * The node of the open flow a paused run is waiting before, or null.
 *
 * The pause names a case and a step id, and a step id is only unique inside one flow: a suite walks
 * several, and «crear» may be a node of each. So the case decides — its `scenarioId` is
 * `workflow:<flow>:<step>`, plus a `#suffix` per dataset row — and a case not in the list yet lights
 * nothing rather than possibly the wrong node.
 */
export function pausedNodeId(
  paused: RunPausePosition | null | undefined,
  cases: readonly { id: string; scenarioId: string }[],
  flowId: string | undefined,
): string | null {
  if (!paused?.stepId || !flowId) return null;
  const waiting = cases.find((runCase) => runCase.id === paused.caseId);
  const prefix = `workflow:${flowId}:`;
  if (!waiting?.scenarioId.startsWith(prefix)) return null;
  return waiting.scenarioId.slice(prefix.length).split("#")[0] === paused.stepId ? paused.stepId : null;
}

/** The nodes a launch would stop before: only in `breakpoints` mode do the marks mean anything. */
export function activeBreakpoints(settings: RunSettings): string[] {
  return settings.pauseMode === "breakpoints" ? settings.breakpoints : [];
}

/**
 * Marks or unmarks a node as a place to stop, from its context menu.
 *
 * Marking a node is asking to stop there and only there, so the run switches to `breakpoints`
 * whatever it was — the chip beside «Ejecutar» shows the change. Taking the last mark away turns it
 * back into a normal run rather than into settings that cannot launch.
 */
export function toggleBreakpoint(settings: RunSettings, stepId: string): RunSettings {
  const active = activeBreakpoints(settings);
  if (active.includes(stepId)) {
    const breakpoints = active.filter((id) => id !== stepId);
    return { ...settings, breakpoints, pauseMode: breakpoints.length ? "breakpoints" : "none" };
  }
  // Marks left over from an earlier `breakpoints` session come back with the mode: they were the
  // person's, and dropping them silently would be a second decision nobody made.
  const breakpoints = settings.breakpoints.includes(stepId) ? settings.breakpoints : [...settings.breakpoints, stepId];
  return { ...settings, breakpoints, pauseMode: "breakpoints" };
}
