/**
 * Which environment a project is working against right now.
 *
 * The analyzer keeps one active environment per project and every screen starts from it: the
 * editor sends against it, a run preselects it, the button in the bar says which one it is.
 * Without it each screen asked again and a person switching from «staging» to «local» had to do
 * it four times.
 *
 * Remembered per browser for now. A run still names its environment explicitly — this only
 * decides what is preselected — so two people on the same project picking different ones is fine.
 */
import { useCallback, useSyncExternalStore } from "react";

const KEY = "eq.active-environment";
const listeners = new Set<() => void>();

function read(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

// The snapshot must be referentially stable between changes, or useSyncExternalStore re-renders
// forever. Parsed once, replaced only when something writes.
let snapshot = typeof window === "undefined" ? {} : read();

export function setActiveEnvironment(projectId: string, environmentId: string | null): void {
  const nextValue = { ...snapshot };
  if (environmentId) nextValue[projectId] = environmentId;
  else delete nextValue[projectId];
  snapshot = nextValue;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(nextValue));
  } catch {
    // Storage denied: the choice holds for this tab.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useActiveEnvironment(
  projectId: string | undefined,
): [string | null, (environmentId: string | null) => void] {
  const all = useSyncExternalStore(subscribe, () => snapshot);
  const set = useCallback(
    (environmentId: string | null) => {
      if (projectId) setActiveEnvironment(projectId, environmentId);
    },
    [projectId],
  );
  return [projectId ? (all[projectId] ?? null) : null, set];
}

/**
 * The active environment if it still exists, else the first one.
 *
 * A deleted environment must not stay «active»: every screen would preselect an id no select can
 * show, and the run button would be disabled with nothing on the screen saying why.
 */
export function resolveActive<T extends { id: string }>(stored: string | null, environments: T[]): T | null {
  return environments.find((environment) => environment.id === stored) ?? environments[0] ?? null;
}
