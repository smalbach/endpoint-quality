/**
 * How large a request body may be, in one place.
 *
 * It has to be one place because two of them disagree silently. The DTO advertises an 8 MB cap
 * on an uploaded contract; Express defaults its JSON parser to **100 KB**. Digital Catalog's
 * `bundled.yaml` is 118 KB, so the declared limit was a lie the first real contract exposed —
 * and it surfaced as a 500 rather than as "your document is too big", which is the least
 * actionable way to fail.
 */
export const MAX_JSON_BODY = "8mb";
/** The same figure the DTO validates against, so the parser and the validator agree on the
 * number rather than each carrying their own. */
export const MAX_SPEC_BYTES = 8_000_000;
