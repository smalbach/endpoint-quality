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
  deleteVersion(id: string): Promise<void>;
}
