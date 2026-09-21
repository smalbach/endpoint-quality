/**
 * Lo que un documento de colección puede decir, comprobado en un sitio.
 *
 * La misma división que trazan flujos y rendimiento: el DTO zanja que llegó un objeto con cadenas
 * de un largo razonable, y esto zanja qué pueden significar esas cadenas —un método que existe, un
 * cuerpo de un modo que se sabe mandar, un árbol que no es infinitamente hondo—. Vive en el
 * dominio y se valida dentro del comando, así que el contrato publicado y lo que acaba en la
 * columna no pueden venir de dos listas que discrepen.
 *
 * Los topes son la versión de `MAX_RUN_CASES` de aquí: una colección cuyo tamaño se sabe leyendo
 * su propio documento se rechaza al guardar, no a mitad de una corrida.
 */
import { z } from "zod";

import { AUTH_TYPES } from "@eq/runner-core";
import { BODY_MODES, ENDPOINT_METHODS, MAX_SCRIPT, PARAMETER_TYPES } from "@/modules/endpoints/domain/model";
import { COLLECTION_ITEM_KINDS } from "./model";

/** Generosos para una colección de verdad —la del catálogo trae 81 peticiones— y bajos para que un
 * fichero absurdo no se guarde. */
export const MAX_COLLECTION_ITEMS = 2_000;
export const MAX_COLLECTION_DEPTH = 10;
export const MAX_COLLECTION_VARIABLES = 500;
export const MAX_COLLECTION_URL = 4_000;

const authSchema = z.object({
  type: z.enum(AUTH_TYPES),
  params: z.record(z.string().max(120), z.string().max(8_000)),
});

const scriptSchema = z.string().max(MAX_SCRIPT);

const pathParameterSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(PARAMETER_TYPES),
  description: z.string().max(2_000),
  value: z.string().max(4_000),
});

const queryParameterSchema = pathParameterSchema.extend({
  required: z.boolean(),
  enabled: z.boolean(),
});

const headerSchema = z.object({
  name: z.string().max(200),
  value: z.string().max(8_000),
  enabled: z.boolean(),
});

const bodySchema = z.object({
  mode: z.enum(BODY_MODES),
  text: z.string().max(1_000_000),
  contentType: z.string().max(200),
  fields: z
    .array(
      z.object({
        name: z.string().max(200),
        value: z.string().max(100_000),
        kind: z.enum(["text", "file"]),
        enabled: z.boolean(),
      }),
    )
    .max(200),
  variables: z.string().max(100_000).optional(),
});

export const collectionRequestSchema = z.object({
  method: z.enum(ENDPOINT_METHODS),
  url: z.string().max(MAX_COLLECTION_URL),
  pathParameters: z.array(pathParameterSchema).max(50),
  query: z.array(queryParameterSchema).max(200),
  headers: z.array(headerSchema).max(200),
  body: bodySchema,
  auth: authSchema,
});

/**
 * El nodo, y con él el árbol.
 *
 * Recursivo con `z.lazy`, y hondo como mucho {@link MAX_COLLECTION_DEPTH}: un JSON anidado diez mil
 * veces es una pila reventada en el primer recorrido, y ninguna colección de las que alguien
 * escribe pasa de tres o cuatro niveles.
 */
const itemSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1).max(80),
      kind: z.enum(COLLECTION_ITEM_KINDS),
      name: z.string().min(1).max(300),
      description: z.string().max(20_000),
      preRequestScript: scriptSchema,
      postResponseScript: scriptSchema,
      auth: authSchema.nullable(),
      request: collectionRequestSchema.nullable(),
      items: z.array(itemSchema).max(MAX_COLLECTION_ITEMS),
    })
    .refine((item) => (item.kind === "request" ? item.request !== null : item.request === null), {
      message: "Una petición lleva `request` y una carpeta no",
      path: ["request"],
    })
    .refine((item) => (item.kind === "folder" ? true : item.items.length === 0), {
      message: "Una petición no contiene otras",
      path: ["items"],
    })
    .refine((item) => (item.kind === "folder" ? true : item.auth === null), {
      message: "La autenticación de una petición va en `request.auth`",
      path: ["auth"],
    }),
);

export const collectionDocumentSchema = z.object({
  auth: authSchema,
  variables: z
    .array(z.object({ key: z.string().min(1).max(120), value: z.string().max(8_000), enabled: z.boolean() }))
    .max(MAX_COLLECTION_VARIABLES),
  preRequestScript: scriptSchema,
  postResponseScript: scriptSchema,
  items: z.array(itemSchema).max(MAX_COLLECTION_ITEMS),
});

type ParseResult = { ok: true } | { ok: false; issues: { field: string; detail: string }[] };

/** El mismo `{ ok, issues }` que usan flujos y planes, para que los problemas se cuenten igual. */
export function safeParseCollectionDocument(data: unknown): ParseResult {
  const result = collectionDocumentSchema.safeParse(data);
  if (!result.success)
    return {
      ok: false,
      issues: result.error.issues.map((issue) => ({
        field: issue.path.length ? issue.path.join(".") : "document",
        detail: issue.message,
      })),
    };
  const size = measure(data as { items: { items: unknown[] }[] });
  if (size.depth > MAX_COLLECTION_DEPTH)
    return {
      ok: false,
      issues: [{ field: "items", detail: `Como mucho ${MAX_COLLECTION_DEPTH} niveles de carpetas` }],
    };
  if (size.count > MAX_COLLECTION_ITEMS)
    return { ok: false, issues: [{ field: "items", detail: `Como mucho ${MAX_COLLECTION_ITEMS} elementos` }] };
  return { ok: true };
}

/**
 * Hondura y número de nodos del árbol entero: los dos topes que el esquema por nivel no ve.
 *
 * Se llama **después** de que el esquema haya dicho que sí, así que `items` es una lista en cada
 * nodo y en el documento: un `?? []` aquí sería una rama que ninguna entrada puede tomar.
 */
function measure(document: { items: { items: unknown[] }[] }): { depth: number; count: number } {
  let count = 0;
  const walk = (items: { items: unknown[] }[], depth: number): number => {
    let deepest = depth;
    for (const item of items) {
      count += 1;
      deepest = Math.max(deepest, walk(item.items as { items: unknown[] }[], depth + 1));
    }
    return deepest;
  };
  const depth = walk(document.items, 0);
  return { depth, count };
}
