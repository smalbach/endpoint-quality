import type { ImportedOperation, ImportProblem } from "@eq/spec-import";

/** One import of a contract, frozen with the bytes it was read from. */
export type SpecVersion = {
  id: string;
  projectId: string;
  sourceId: string | null;
  hash: string;
  raw: string;
  format: string;
  openapiVersion: string;
  title: string;
  contractVersion: string;
  operationCount: number;
  problems: ImportProblem[];
  importedBy: string;
  importedAt: Date;
};

/** A version without its document. Listing ten versions must not ship ten copies of a 120 KB
 * contract to a browser that only needs to render dates and counts. */
export type SpecVersionSummary = Omit<SpecVersion, "raw">;

/**
 * A stored operation.
 *
 * `id` stays the **contract's** `operationId`, inherited from `ImportedOperation`, and the row's
 * primary key is called `rowId`. The other way round is the obvious mistake and a quiet one:
 * `diffOperations` matches versions by `id`, so keying it to the row would compare two sets of
 * freshly generated UUIDs and report every operation as removed and re-added on each import.
 * Configuration is keyed by `operationId` for the same reason — it has to survive a re-import.
 */
export type SpecOperation = ImportedOperation & { rowId: string; specVersionId: string; position: number };

export type SpecSource = {
  id: string;
  projectId: string;
  kind: string;
  location: string;
  headersCiphertext: string | null;
  createdAt: Date;
};
