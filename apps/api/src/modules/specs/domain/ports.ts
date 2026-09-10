import type { SpecOperation, SpecSource, SpecVersion, SpecVersionSummary } from "./model";

export const SPEC_REPOSITORY = Symbol("SPEC_REPOSITORY");

export interface SpecRepositoryPort {
  findVersionById(id: string): Promise<SpecVersion | null>;
  findVersionByHash(projectId: string, hash: string): Promise<SpecVersion | null>;
  listVersions(projectId: string): Promise<SpecVersionSummary[]>;
  /** The version and its operations are written together: a version with no operation rows is a
   * contract the engine would read as empty, and it would look like full coverage of nothing. */
  saveVersion(version: SpecVersion, operations: SpecOperation[]): Promise<void>;
  listOperations(specVersionId: string): Promise<SpecOperation[]>;
  saveSource(source: SpecSource): Promise<void>;
  /** The source row for exactly this location, if the project already has one. Reused rather than
   * duplicated: every import of the same URL is the same source, and the headers stored against
   * it are what let the next import happen without somebody retyping a credential. */
  findSourceByLocation(projectId: string, kind: string, location: string): Promise<SpecSource | null>;
  /** The most recent source of a project, whatever its kind. What a drift check falls back to
   * when the caller did not say where to look. */
  findLatestSource(projectId: string): Promise<SpecSource | null>;
  deleteVersion(id: string): Promise<void>;
}
