import { createHash } from "node:crypto";

/**
 * The identity of a document, for telling one import from another.
 *
 * Over the **raw bytes**, deliberately: two documents that differ only in a description are
 * still two documents, and an operator asking "did the contract change" is asking about the
 * file. The operation-level diff answers the narrower question of whether anything the engine
 * cares about moved.
 */
export function fingerprint(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}
