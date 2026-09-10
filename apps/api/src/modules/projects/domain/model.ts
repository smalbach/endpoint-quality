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
};

export function isArchived(project: Project): boolean {
  return project.archivedAt !== null;
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
