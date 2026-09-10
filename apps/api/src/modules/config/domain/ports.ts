import type { ConfigSection } from "@eq/runner-core";

export const CONFIG_REPOSITORY = Symbol("CONFIG_REPOSITORY");

export type ConfigRow = { projectId: string; section: ConfigSection; data: unknown; updatedAt: Date; updatedBy: string };

export interface ConfigRepositoryPort {
  listSections(projectId: string): Promise<ConfigRow[]>;
  findSection(projectId: string, section: ConfigSection): Promise<ConfigRow | null>;
  saveSection(row: ConfigRow): Promise<void>;
  deleteSection(projectId: string, section: ConfigSection): Promise<void>;
}
