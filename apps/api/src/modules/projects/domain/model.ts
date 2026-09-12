import { projectAuthProblems, type ProjectAuthInput, type StoredProjectAuth } from "./project-auth";

/**
 * A project is the unit of configuration: one contract, and everything a team decided about how
 * to exercise it.
 *
 * Everything the coupled dashboard held as literals across five modules — the fixtures, the
 * payloads, the latency table, the envelope map — hangs off this id. That is the whole shape of
 * the decoupling in one sentence.
 */
export type Project = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description: string;
  createdBy: string;
  createdAt: Date;
  /** Archived rather than deleted. A project owns runs, and a run is evidence somebody produced
   * on a date; removing the project to tidy a list would destroy the history. */
  archivedAt: Date | null;
  activeSpecVersionId: string | null;
  /** The API this project points at. Each environment still has its own URL; this is the one a
   * new environment starts from and the one the analyzer's screens show. */
  baseUrl: string;
  tags: string[];
  auth: StoredProjectAuth;
  /** Deleted for everybody. A deleted project answers 404 everywhere; its runs are kept. */
  deletedAt: Date | null;
};

export function isArchived(project: Project): boolean {
  return project.archivedAt !== null;
}

export type ProjectSettingsInput = { baseUrl?: string; tags?: string[]; auth?: ProjectAuthInput };

/** Tags compared the way people type them: trimmed, once each, in the order given. */
export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

export function projectSettingsProblems(
  input: ProjectSettingsInput,
  previousAuth: StoredProjectAuth,
): { field: string; detail: string }[] {
  const problems: { field: string; detail: string }[] = [];
  const baseUrl = input.baseUrl?.trim();
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:")
        problems.push({ field: "baseUrl", detail: "Solo http o https" });
    } catch {
      problems.push({ field: "baseUrl", detail: "No es una URL válida" });
    }
  }
  if (input.auth) problems.push(...projectAuthProblems(input.auth, previousAuth));
  return problems;
}

export function slugifyProject(name: string): string {
  return (
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "proyecto"
  );
}
