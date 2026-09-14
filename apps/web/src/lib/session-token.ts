/**
 * The session token as the bar shows it: when it runs out, and what it says about who is holding it.
 *
 * The token itself never reaches the browser — the API keeps it encrypted and applies it to «Enviar»
 * — so everything here is about the view: a countdown, a colour, and the claims worth reading.
 */
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useOrganization } from "@/lib/auth";
import type { SessionTokenView } from "@/lib/types";

export function useSessionToken(projectId: string | undefined) {
  const organization = useOrganization();
  return useQuery({
    queryKey: ["session-token", projectId],
    enabled: Boolean(organization && projectId),
    queryFn: async () =>
      (await api<{ token: SessionTokenView | null }>(`/orgs/${organization?.id}/projects/${projectId}/session-token`))
        .token,
  });
}

/** `2h 5m`, `4m 12s`, `9s` — the analyzer's format, at the precision that still changes. */
export function formatCountdown(milliseconds: number): string {
  if (milliseconds <= 0) return "Caducado";
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export type CountdownTone = "expired" | "urgent" | "soon" | "ok";

/** Red under a minute, amber under five. */
export function countdownTone(milliseconds: number): CountdownTone {
  if (milliseconds <= 0) return "expired";
  if (milliseconds < 60_000) return "urgent";
  if (milliseconds < 5 * 60_000) return "soon";
  return "ok";
}

/**
 * The claims as `name: value` lines. `iat` and `nbf` are left out — they say when the token was
 * made, which nobody debugging a 401 is asking — and `exp` stays, because the countdown is derived
 * from it and seeing the raw number is how somebody checks the countdown is right.
 */
export function visibleClaims(claims: Record<string, unknown> | null): [string, string][] {
  if (!claims) return [];
  return Object.entries(claims)
    .filter(([name]) => name !== "iat" && name !== "nbf")
    .map(([name, value]) => [name, typeof value === "string" ? value : JSON.stringify(value)]);
}
