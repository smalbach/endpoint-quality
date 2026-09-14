import type { ScanDiff } from "./diff";
import type { ScanResult } from "./analyze-nest";

/**
 * A saved connection to a repository, so a scan does not retype the same four things every time.
 *
 * The token is the only secret here and it is stored the way every target credential is: AES-256-GCM
 * ciphertext, decrypted in memory at scan time and never returned. A connector with no token is a
 * public repo, or the upload path — both are allowed, because «Ambos» is the point.
 */
export type CodeConnector = {
  id: string;
  projectId: string;
  provider: "github";
  /** `owner/repo`. */
  repo: string;
  branch: string;
  /** Only files under this path are scanned, so a monorepo's `apps/api/src` is reachable. */
  basePath: string;
  /** The app's global prefix, applied to every scanned route so it matches the contract's paths. */
  prefix: string;
  tokenCiphertext: string | null;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
};

export const SCAN_SOURCES = ["github", "upload"] as const;
export type ScanSource = (typeof SCAN_SOURCES)[number];

export const CODE_SCAN_STATUSES = ["ok", "error"] as const;
export type CodeScanStatus = (typeof CODE_SCAN_STATUSES)[number];

/**
 * What a scan means beyond the routes: the roles the code names that the project has not, and the
 * endpoints the code dropped that something still points at.
 *
 * This is the half of the impact analysis that needs the rest of the project — the flows and the
 * permissions — so it is computed in the application layer, not the pure parser.
 */
export type ScanImpact = {
  unknownRoles: string[];
  /** Endpoints the code no longer has that a role permission still references — importing the removal
   * would orphan them. */
  removedWithPermissions: { method: string; path: string; permissions: number }[];
  /** Endpoints the code no longer has that a flow's request still targets. */
  removedWithFlows: { method: string; path: string; flows: number }[];
};

export type CodeScan = {
  id: string;
  projectId: string;
  source: ScanSource;
  /** The branch, a commit, or `"upload"` — what was read. */
  ref: string;
  status: CodeScanStatus;
  result: ScanResult;
  diff: ScanDiff;
  impact: ScanImpact;
  error: string | null;
  createdAt: Date;
  createdBy: string;
};
