/**
 * Which environment a project is working against right now.
 *
 * The analyzer keeps one active environment per project and every screen starts from it: the
 * editor sends against it, a run preselects it, the button in the bar says which one it is.
 *
 * **It is the server's answer now**, `active` on each environment, and no longer a key in this
 * browser's storage: two people on the same project see the same one, and a reload or another
 * device does not quietly go back to the first environment of the list. Choosing one is a write,
 * so it needs `editor`; for anyone below that the choice is shown and not offered.
 */
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import type { Environment } from "@/lib/types";

export function useActiveEnvironment(
  projectId: string | undefined,
): [string | null, (environmentId: string | null) => void] {
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const queryClient = useQueryClient();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;

  const environments = useQuery({
    queryKey: ["environments", projectId],
    enabled: Boolean(organization && projectId),
    queryFn: () => api<Environment[]>(`${base}/environments`),
  });

  const activate = useMutation({
    mutationFn: (environmentId: string) =>
      api<void>(`${base}/environments/${environmentId}/activate`, { method: "POST" }),
    // Moved in the cache first, so the bar, the editor and the selects agree the moment it is
    // clicked; the refetch afterwards is what makes it true.
    onMutate: (environmentId) => {
      queryClient.setQueryData<Environment[]>(["environments", projectId], (current) =>
        current?.map((environment) => ({ ...environment, active: environment.id === environmentId })),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["environments", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });

  const { mutate } = activate;
  const set = useCallback(
    (environmentId: string | null) => {
      if (!projectId || !environmentId || !canEdit) return;
      const current = environments.data?.find((environment) => environment.active)?.id;
      if (current !== environmentId) mutate(environmentId);
    },
    [projectId, canEdit, environments.data, mutate],
  );

  return [environments.data?.find((environment) => environment.active)?.id ?? null, set];
}

/**
 * The environment a screen should use: the one it was told about, else the project's active one.
 *
 * Never «the first of the list» any more. The server keeps exactly one active whenever there is
 * any, so a missing one means there are none — and a select preselecting an arbitrary environment
 * would be a guess shown as a decision.
 */
export function resolveActive<T extends { id: string; active?: boolean }>(
  stored: string | null,
  environments: T[],
): T | null {
  return (
    environments.find((environment) => environment.id === stored) ??
    environments.find((environment) => environment.active) ??
    null
  );
}
