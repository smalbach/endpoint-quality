import type { SourceInput } from "./analyze-nest";
import type { CodeConnector, CodeScan } from "./model";

export const CODE_CONNECTOR_REPOSITORY = Symbol("CODE_CONNECTOR_REPOSITORY");
export const CODE_SCAN_REPOSITORY = Symbol("CODE_SCAN_REPOSITORY");
export const GITHUB_SOURCE = Symbol("GITHUB_SOURCE");

/** One connector per project — the reference connects a project to a repo, not many. */
export interface CodeConnectorRepositoryPort {
  find(projectId: string): Promise<CodeConnector | null>;
  save(connector: CodeConnector): Promise<void>;
  delete(projectId: string): Promise<void>;
}

export interface CodeScanRepositoryPort {
  list(projectId: string): Promise<CodeScan[]>;
  find(projectId: string, scanId: string): Promise<CodeScan | null>;
  save(scan: CodeScan): Promise<void>;
  delete(projectId: string, scanId: string): Promise<void>;
}

/** Fetches a repo's controller sources. The one adapter talks to the GitHub API behind the SSRF
 * guard; a stub stands in for it in tests, which is why the command depends on the port and not on
 * `fetch`. `ref` is the branch or commit the files were read at, for the scan's record. */
export interface GithubSourcePort {
  fetchControllers(input: {
    repo: string;
    branch: string;
    basePath: string;
    token: string | null;
  }): Promise<{ sources: SourceInput[]; ref: string }>;
}
