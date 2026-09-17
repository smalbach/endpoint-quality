/**
 * What a thing somebody dropped in **is**, decided by looking at it.
 *
 * This is the piece Postman's import has and this product did not. There, you press Import, hand
 * over files, a link or a paste, and it tells you what it found — a collection, an environment, a
 * data dump, an OpenAPI document — and where each piece is going. You never pick the format.
 *
 * **It lives in a package of its own, and that is the point.** The detector has to give the same
 * answer on both sides of the wire: the browser needs it to name what you just dropped *before*
 * anything is sent, and the server needs it to decide what to actually do with it. Two copies of
 * this function would be two copies free to disagree, and the disagreement would show up as a
 * dialog promising one thing and an import doing another. So there is one, imported by both.
 *
 * **By content, never by filename.** What Postman downloads is called whatever the browser felt
 * like, `Catalog-API.json` is as likely to be a collection as an environment, and a `.txt` full of
 * `curl` commands is a perfectly ordinary thing to have. The name is used for two things only:
 * telling YAML from JSON when the content is ambiguous, and spotting a `.zip` — and even there the
 * content wins.
 *
 * **A dump explodes into its pieces.** «Export data» in Postman produces one file holding every
 * collection and every environment, and it is how a team moves everything at once — so it is read
 * as the several things it is rather than refused as a shape nobody expected.
 */

/** What a source can turn out to be. `unknown` always carries a reason. */
export const IMPORT_KINDS = [
  "postman-collection",
  "postman-environment",
  "postman-dump",
  "openapi",
  "insomnia",
  "curl",
  "eq-bundle",
  "unknown",
] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/** A kind that is one readable thing, rather than a container or a refusal. */
export type PieceKind = Exclude<ImportKind, "postman-dump" | "unknown">;

/** Where each piece lands. The dialog shows it, the server obeys it: one table, so neither lies. */
export const IMPORT_TARGETS = ["contract", "endpoints", "flows", "environment", "project"] as const;
export type ImportTarget = (typeof IMPORT_TARGETS)[number];

/**
 * What a piece of this kind writes, in the order it writes it.
 *
 * Exported because the dialog's «va a…» line and the server's routing are the same claim, and the
 * only way they cannot drift is by being the same array.
 */
export function targetsOf(kind: PieceKind): ImportTarget[] {
  switch (kind) {
    case "openapi":
      return ["contract"];
    case "postman-environment":
      return ["environment"];
    case "postman-collection":
      return ["endpoints", "flows"];
    case "eq-bundle":
      return ["project"];
    case "insomnia":
    case "curl":
      return ["endpoints"];
  }
}

/** One readable thing, ready for the command that knows what to do with it. */
export type DetectedPiece = {
  kind: PieceKind;
  /** What to call it in the report. */
  name: string;
  /** What is inside, counted — «53 peticiones · 6 carpetas». Null when there is nothing to count. */
  detail: string | null;
  /** Its own text, so a piece of a dump is indistinguishable from a file of its own. */
  text: string;
};

export type Detected = {
  kind: ImportKind;
  name: string;
  /** Everything readable in it: one piece for a file, several for a dump, none for `unknown`. */
  pieces: DetectedPiece[];
  /** Why nothing could be read, or null. Said in words, because «no se reconoce» is not something
   * anybody can act on and «Collection v1 ya no se admite» is. */
  reason: string | null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const nameOf = (document: Record<string, unknown>, fallback: string): string =>
  asString(asRecord(document.info)?.name) || asString(document.name) || fallback;
const count = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The format string an exported project file carries. Kept in step with the api's own copy. */
const EQ_BUNDLE_FORMAT = "endpoint-quality/project";

export function detectImport(filename: string, text: string): Detected {
  const label = filename.trim() || "lo pegado";
  if (!text.trim()) return { kind: "unknown", name: label, pieces: [], reason: "está vacío" };

  // A zip, by its magic bytes or by its name. Postman's «Export data» downloads one, so somebody
  // dropping it here is doing the obvious thing and deserves better than «no es JSON».
  if (text.startsWith("PK") || /\.zip$/i.test(label)) {
    return {
      kind: "unknown",
      name: label,
      pieces: [],
      reason: "es un .zip: descomprímelo y suelta los .json que hay dentro (se pueden soltar todos a la vez)",
    };
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let document: unknown;
    try {
      document = JSON.parse(trimmed);
    } catch (error) {
      return {
        kind: "unknown",
        name: label,
        pieces: [],
        reason: `empieza como JSON y no lo es: ${error instanceof Error ? error.message : "sin detalle"}`,
      };
    }
    return fromJson(document, label);
  }

  // Not JSON. Two things a person actually has in plain text.
  if (/^\s*(openapi|swagger)\s*:/m.test(trimmed)) {
    return {
      kind: "openapi",
      name: label,
      pieces: [{ kind: "openapi", name: label, detail: yamlDetail(trimmed), text }],
      reason: null,
    };
  }
  if (/^[ \t]*curl[\s\\]/m.test(trimmed)) {
    const commands = (trimmed.match(/^[ \t]*curl[\s\\]/gm) ?? []).length;
    return {
      kind: "curl",
      name: label,
      pieces: [{ kind: "curl", name: label, detail: plural(commands, "comando", "comandos"), text }],
      reason: null,
    };
  }
  return {
    kind: "unknown",
    name: label,
    pieces: [],
    reason: "no es JSON, ni un OpenAPI en YAML, ni un texto con comandos curl",
  };
}

function fromJson(parsed: unknown, label: string): Detected {
  const document = asRecord(parsed);
  if (!document) {
    return {
      kind: "unknown",
      name: label,
      pieces: [],
      reason: "el JSON de la raíz es una lista, y ningún formato de import empieza así",
    };
  }

  // An exported project of this product **before everything else**, because it is the only format
  // that says what it is in a field of its own — and because it carries an `environments` array,
  // so the data-dump test below would swallow it and read it as somebody's Postman export.
  if (asString(document.format) === EQ_BUNDLE_FORMAT) {
    const name =
      asString(asRecord(document.settings)?.name) ||
      asString(asRecord(document.project)?.name) ||
      nameOf(document, label);
    return {
      kind: "eq-bundle",
      name,
      pieces: [{ kind: "eq-bundle", name, detail: bundleDetail(document), text: JSON.stringify(document) }],
      reason: null,
    };
  }

  // A data dump first: it *contains* the other shapes, so any test that looks for one of them
  // would match the dump's insides and read the whole file as its first collection.
  const collections = Array.isArray(document.collections) ? document.collections : null;
  const environments = Array.isArray(document.environments) ? document.environments : null;
  if (collections || environments) {
    const pieces: DetectedPiece[] = [];
    for (const [index, entry] of (collections ?? []).entries()) {
      const item = asRecord(entry);
      if (!item || !Array.isArray(item.item)) continue;
      pieces.push(collectionPiece(item, nameOf(item, `Colección ${index + 1}`)));
    }
    for (const [index, entry] of (environments ?? []).entries()) {
      const item = asRecord(entry);
      if (!item || !Array.isArray(item.values)) continue;
      pieces.push(environmentPiece(item, nameOf(item, `Entorno ${index + 1}`)));
    }
    return {
      kind: "postman-dump",
      name: nameOf(document, label),
      pieces,
      reason: pieces.length ? null : "es un volcado de Postman y no trae ninguna colección ni entorno legible",
    };
  }

  if (Array.isArray(document.item)) {
    const name = nameOf(document, label);
    return { kind: "postman-collection", name, pieces: [collectionPiece(document, name)], reason: null };
  }
  if (Array.isArray(document.values)) {
    const name = nameOf(document, label);
    return { kind: "postman-environment", name, pieces: [environmentPiece(document, name)], reason: null };
  }
  if (asString(document._type) === "export" || Array.isArray(document.resources)) {
    return {
      kind: "insomnia",
      name: label,
      pieces: [
        {
          kind: "insomnia",
          name: label,
          detail: plural(count(document.resources), "recurso", "recursos"),
          text: JSON.stringify(document),
        },
      ],
      reason: null,
    };
  }
  if (typeof document.openapi === "string" || typeof document.swagger === "string") {
    const paths = asRecord(document.paths);
    return {
      kind: "openapi",
      name: nameOf(document, label),
      pieces: [
        {
          kind: "openapi",
          name: label,
          detail: paths ? plural(Object.keys(paths).length, "ruta", "rutas") : null,
          text: JSON.stringify(document),
        },
      ],
      reason: null,
    };
  }
  // Postman's own answer to a v1 collection, and worth repeating word for word: the shape is
  // recognisable, it is genuinely not supported, and there is something the person can do.
  if (Array.isArray(document.requests)) {
    return {
      kind: "unknown",
      name: nameOf(document, label),
      pieces: [],
      reason: "es una colección de Postman v1, que ya no se admite: expórtala como v2.1",
    };
  }
  if (asRecord(document.log)) {
    return {
      kind: "unknown",
      name: label,
      pieces: [],
      reason: "es un HAR del navegador, que todavía no se lee: exporta las peticiones como curl",
    };
  }
  return {
    kind: "unknown",
    name: nameOf(document, label),
    pieces: [],
    reason: "es JSON, pero no de ningún formato conocido",
  };
}

function collectionPiece(document: Record<string, unknown>, name: string): DetectedPiece {
  let requests = 0;
  let folders = 0;
  const walk = (items: unknown) => {
    for (const entry of Array.isArray(items) ? items : []) {
      const item = asRecord(entry);
      if (!item) continue;
      if (Array.isArray(item.item)) {
        folders += 1;
        walk(item.item);
      } else if (item.request) requests += 1;
    }
  };
  walk(document.item);
  const parts = [plural(requests, "petición", "peticiones")];
  if (folders) parts.push(plural(folders, "carpeta", "carpetas"));
  return { kind: "postman-collection", name, detail: parts.join(" · "), text: JSON.stringify(document) };
}

function environmentPiece(document: Record<string, unknown>, name: string): DetectedPiece {
  const values = Array.isArray(document.values) ? document.values : [];
  const secrets = values.filter((entry) => {
    const type = asString(asRecord(entry)?.type);
    return type === "secret" || type === "password";
  }).length;
  const parts = [plural(values.length, "variable", "variables")];
  if (secrets) parts.push(plural(secrets, "secreta", "secretas"));
  // A globals export has `values` too, and saying so is the difference between «este entorno se
  // llama raro» and «esto son las globals de tu workspace».
  if (asString(document._postman_variable_scope) === "globals") parts.push("globals del workspace");
  return { kind: "postman-environment", name, detail: parts.join(" · "), text: JSON.stringify(document) };
}

/** What an exported project carries, named the way the export dialog names it. */
function bundleDetail(document: Record<string, unknown>): string {
  const flows = asRecord(document.flows) ?? {};
  const parts: string[] = [];
  if (asString(asRecord(document.contract)?.raw)) parts.push("contrato");
  if (count(document.endpoints)) parts.push(plural(count(document.endpoints), "endpoint", "endpoints"));
  if (count(flows.workflows)) parts.push(plural(count(flows.workflows), "flujo", "flujos"));
  if (count(document.environments)) parts.push(plural(count(document.environments), "entorno", "entornos"));
  if (count(document.roles)) parts.push(plural(count(document.roles), "rol", "roles"));
  return parts.length ? parts.join(" · ") : "nada que importar";
}

/** Rutas de un OpenAPI en YAML, contadas sin parsearlo: las claves de primer nivel bajo `paths:`. */
function yamlDetail(text: string): string | null {
  const start = text.search(/^paths\s*:/m);
  if (start < 0) return null;
  const after = text.slice(start).split(/\r?\n/).slice(1);
  let paths = 0;
  for (const line of after) {
    if (/^\S/.test(line)) break;
    if (/^[ \t]{1,4}["'/]/.test(line) && line.trimEnd().endsWith(":")) paths += 1;
  }
  return paths ? plural(paths, "ruta", "rutas") : null;
}
