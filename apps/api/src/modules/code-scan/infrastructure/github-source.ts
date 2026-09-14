import { Inject, Injectable } from "@nestjs/common";

import { SAFE_FETCH, type SafeFetchPort } from "@/shared/http/safe-fetch";
import type { SourceInput } from "../domain/analyze-nest";
import type { GithubSourcePort } from "../domain/ports";

const API = "https://api.github.com";
/** A cap on how many files one scan pulls, so a huge monorepo cannot turn one click into thousands
 * of requests. Controllers are a small fraction of a repo, so this is generous in practice. */
const MAX_FILES = 300;

type TreeEntry = { path: string; type: string };

/**
 * The GitHub API, read through the SSRF guard.
 *
 * Two calls and no clone: the tree of the branch, then the content of each `*.controller.ts` under
 * the base path. `api.github.com` is a public host, so the guard allows it; a token, when the
 * connector has one, travels only in the Authorization header of these requests and is never stored
 * or logged in the clear. A private repo without a token simply returns nothing to scan, which is the
 * honest outcome rather than a half-scan.
 */
@Injectable()
export class GithubSource implements GithubSourcePort {
  constructor(@Inject(SAFE_FETCH) private readonly http: SafeFetchPort) {}

  async fetchControllers(input: {
    repo: string;
    branch: string;
    basePath: string;
    token: string | null;
  }): Promise<{ sources: SourceInput[]; ref: string }> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "endpoint-quality",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (input.token) headers.Authorization = `Bearer ${input.token}`;

    const treeUrl = `${API}/repos/${input.repo}/git/trees/${encodeURIComponent(input.branch)}?recursive=1`;
    const treeResponse = await this.http.request(treeUrl, { method: "GET", headers });
    if (treeResponse.status < 200 || treeResponse.status >= 300)
      throw new Error(`GitHub respondió ${treeResponse.status} al leer el árbol de ${input.repo}@${input.branch}`);
    const tree = JSON.parse(treeResponse.body) as { tree?: TreeEntry[]; sha?: string };

    const base = input.basePath.replace(/^\/+|\/+$/g, "");
    const wanted = (tree.tree ?? [])
      .filter((entry) => entry.type === "blob" && entry.path.endsWith(".controller.ts"))
      .filter((entry) => (base ? entry.path.startsWith(`${base}/`) || entry.path === base : true))
      .slice(0, MAX_FILES);

    const sources: SourceInput[] = [];
    for (const entry of wanted) {
      const url = `${API}/repos/${input.repo}/contents/${entry.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(input.branch)}`;
      const response = await this.http.request(url, { method: "GET", headers });
      if (response.status < 200 || response.status >= 300) continue;
      const file = JSON.parse(response.body) as { content?: string; encoding?: string };
      if (file.encoding !== "base64" || !file.content) continue;
      sources.push({ path: entry.path, content: Buffer.from(file.content, "base64").toString("utf8") });
    }

    return { sources, ref: tree.sha ? `${input.branch}@${tree.sha.slice(0, 8)}` : input.branch };
  }
}
