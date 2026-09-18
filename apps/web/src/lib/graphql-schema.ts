/**
 * El esquema de una API GraphQL en el editor: de dónde sale, qué dice de la operación escrita y qué
 * operaciones ofrece.
 *
 * Es la mitad de Postman que un cuadro de texto no tiene. Allí la petición GraphQL carga el esquema
 * por introspección y a partir de ahí la operación se valida mientras se escribe y las consultas se
 * eligen de una lista. Aquí igual, con dos fuentes:
 *
 * - **Introspección**, mandada por el mismo «Enviar» que la petición —su entorno, su autenticación,
 *   la guarda de SSRF—. Es la consulta estándar de `graphql-js`, la que contesta cualquier servidor.
 * - **Un fichero**: el SDL (`schema.graphql`) o el JSON de una introspección guardada. Muchos
 *   servidores de producción tienen la introspección apagada, y el esquema existe igual en el repo.
 *
 * Todo esto vive en el navegador y **no se guarda**: un esquema pesa lo que pesa la API y cambia con
 * cada despliegue, así que se vuelve a pedir en vez de quedarse viejo en una fila.
 *
 * `graphql` se carga aparte (el editor lo importa bajo demanda): son ~150 kB que solo necesita quien
 * abre un cuerpo GraphQL.
 */
import {
  GraphQLError,
  buildClientSchema,
  buildSchema,
  getIntrospectionQuery,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isLeafType,
  isListType,
  isNonNullType,
  isObjectType,
  isUnionType,
  parse,
  validate,
  type GraphQLField,
  type GraphQLInputType,
  type GraphQLOutputType,
  type GraphQLSchema,
  type IntrospectionQuery,
} from "graphql";

export type { GraphQLSchema };

/** La consulta de introspección de `graphql-js`, con descripciones: es lo que se enseña al elegir. */
export const INTROSPECTION_QUERY = getIntrospectionQuery({ descriptions: true });

export type SchemaRead = { ok: true; schema: GraphQLSchema } | { ok: false; problem: string };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * La respuesta a la introspección —`{data: {__schema}}`— o el JSON que alguien guardó de ella, que
 * a veces es solo `{__schema}`. Un servidor con la introspección apagada contesta 200 con `errors`,
 * y eso se dice con su mensaje: «no se pudo leer» no deja hacer nada, «introspection is disabled» sí.
 */
export function schemaFromIntrospection(body: unknown): SchemaRead {
  let value = body;
  if (typeof body === "string") {
    try {
      value = JSON.parse(body);
    } catch {
      return { ok: false, problem: "La respuesta no es JSON: el servidor no contestó como uno de GraphQL" };
    }
  }
  const record = asRecord(value);
  const data = asRecord(record?.data) ?? record;
  if (!asRecord(data?.__schema)) {
    const errors = Array.isArray(record?.errors) ? record.errors : [];
    const message = errors
      .map((error) => asRecord(error)?.message)
      .filter((text): text is string => typeof text === "string")
      .join(" · ");
    return {
      ok: false,
      problem: message
        ? `El servidor no dio su esquema: ${message}`
        : "La respuesta no trae «__schema»: puede que la introspección esté apagada. Carga el SDL desde un fichero",
    };
  }
  try {
    return { ok: true, schema: buildClientSchema(data as unknown as IntrospectionQuery) };
  } catch (error) {
    return { ok: false, problem: `El esquema no se pudo leer: ${messageOf(error)}` };
  }
}

/** Un SDL: `type Query { … }`. Los errores salen con su línea, que es lo que se busca en el fichero. */
export function schemaFromSdl(text: string): SchemaRead {
  try {
    return { ok: true, schema: buildSchema(text) };
  } catch (error) {
    return { ok: false, problem: `El SDL no se pudo leer: ${messageOf(error)}` };
  }
}

/** Un fichero, sea cual sea de los dos: JSON es una introspección guardada, lo demás es SDL. */
export function schemaFromText(text: string): SchemaRead {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, problem: "El fichero está vacío" };
  return trimmed.startsWith("{") ? schemaFromIntrospection(trimmed) : schemaFromSdl(trimmed);
}

function messageOf(error: unknown): string {
  if (error instanceof GraphQLError) {
    const at = error.locations?.[0];
    return at ? `${error.message} (línea ${at.line}, columna ${at.column})` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export type QueryProblem = { message: string; line: number | null; column: number | null };

/** Una `{{plantilla}}` fuera de una cadena: `user(id: {{id}})`. Dentro de una cadena es texto. */
const BARE_TEMPLATE = /\{\{\s*[^{}]+?\s*\}\}(?=(?:[^"]*"[^"]*")*[^"]*$)/;

/**
 * Lo que está mal en la operación: la sintaxis siempre, y contra el esquema cuando lo hay.
 *
 * Una `{{plantilla}}` suelta en la operación no es GraphQL hasta que se sustituye. En ese caso solo
 * se mira la sintaxis, con la plantilla como `null`: validarla contra el esquema daría un error
 * sobre un valor que nadie va a mandar. Las variables de GraphQL (`$id`) son la forma que no tiene
 * ese problema, y la que genera el explorador.
 */
export function queryProblems(schema: GraphQLSchema | null, query: string): QueryProblem[] {
  if (!query.trim()) return [];
  const templated = BARE_TEMPLATE.test(query);
  const text = templated ? query.replace(new RegExp(BARE_TEMPLATE.source, "g"), "null") : query;
  let document;
  try {
    document = parse(text);
  } catch (error) {
    return [problemOf(error)];
  }
  if (!schema || templated) return [];
  return validate(schema, document).map(problemOf);
}

function problemOf(error: unknown): QueryProblem {
  const at = error instanceof GraphQLError ? error.locations?.[0] : undefined;
  return {
    message: error instanceof Error ? error.message : String(error),
    line: at?.line ?? null,
    column: at?.column ?? null,
  };
}

export type OperationKind = "query" | "mutation" | "subscription";

export type RootField = {
  operation: OperationKind;
  name: string;
  description: string;
  args: { name: string; type: string; required: boolean }[];
  type: string;
  deprecated: boolean;
};

/** Las operaciones que el esquema ofrece: los campos de `Query`, `Mutation` y `Subscription`. */
export function rootFields(schema: GraphQLSchema): RootField[] {
  const roots: [OperationKind, ReturnType<GraphQLSchema["getQueryType"]>][] = [
    ["query", schema.getQueryType()],
    ["mutation", schema.getMutationType()],
    ["subscription", schema.getSubscriptionType()],
  ];
  return roots.flatMap(([operation, type]) =>
    type
      ? Object.values(type.getFields()).map((field) => ({
          operation,
          name: field.name,
          description: field.description ?? "",
          args: field.args.map((arg) => ({
            name: arg.name,
            type: String(arg.type),
            required: isNonNullType(arg.type),
          })),
          type: String(field.type),
          deprecated: Boolean(field.deprecationReason),
        }))
      : [],
  );
}

/** Hasta dónde baja la selección generada. Dos niveles se leen; cinco son una pared de llaves. */
const SELECTION_DEPTH = 2;

/**
 * Una operación lista para mandar sobre un campo raíz: sus argumentos obligatorios como variables
 * de GraphQL, y una selección de los campos hoja hasta dos niveles.
 *
 * Variables y no valores en línea porque así la operación no cambia con cada valor —es la que se
 * guarda y se documenta— y los valores van en el JSON, que admite `{{plantillas}}` con su tipo.
 * Los argumentos opcionales se quedan fuera: el explorador los enseña y quien los quiera los añade;
 * ponerlos todos es una operación que nadie escribiría.
 */
export function operationFor(
  schema: GraphQLSchema,
  operation: OperationKind,
  fieldName: string,
): { query: string; variables: string } | null {
  const root =
    operation === "query"
      ? schema.getQueryType()
      : operation === "mutation"
        ? schema.getMutationType()
        : schema.getSubscriptionType();
  const field = root?.getFields()[fieldName];
  if (!field) return null;

  const required = field.args.filter((arg) => isNonNullType(arg.type) && arg.defaultValue === undefined);
  const definitions = required.length
    ? `(${required.map((arg) => `$${arg.name}: ${String(arg.type)}`).join(", ")})`
    : "";
  const call = required.length ? `(${required.map((arg) => `${arg.name}: $${arg.name}`).join(", ")})` : "";
  const selection = selectionOf(field.type, SELECTION_DEPTH, "  ");
  const name = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
  const query = `${operation} ${name}${definitions} {\n  ${fieldName}${call}${selection}\n}`;
  const variables = required.length
    ? JSON.stringify(Object.fromEntries(required.map((arg) => [arg.name, exampleOf(arg.type, 3)])), null, 2)
    : "";
  return { query, variables };
}

/** ` { a b c }` sangrado, o nada cuando el tipo es una hoja. */
function selectionOf(type: GraphQLOutputType, depth: number, indent: string): string {
  const named = getNamedType(type);
  if (isLeafType(named)) return "";
  if (isUnionType(named)) return ` {\n${indent}  __typename\n${indent}}`;
  if (!isObjectType(named) && !isInterfaceType(named)) return "";
  const lines: string[] = [];
  for (const field of Object.values(named.getFields()) as GraphQLField<unknown, unknown>[]) {
    // Un campo con argumentos obligatorios no se puede pedir sin inventar sus valores.
    if (field.args.some((arg) => isNonNullType(arg.type) && arg.defaultValue === undefined)) continue;
    if (field.deprecationReason) continue;
    const inner = getNamedType(field.type);
    if (isLeafType(inner)) lines.push(`${indent}  ${field.name}`);
    else if (depth > 1) {
      const nested = selectionOf(field.type, depth - 1, `${indent}  `);
      if (nested) lines.push(`${indent}  ${field.name}${nested}`);
    }
  }
  if (!lines.length) lines.push(`${indent}  __typename`);
  return ` {\n${lines.join("\n")}\n${indent}}`;
}

/** Un valor de ejemplo con la forma del tipo: lo que se rellena, no lo que se manda sin mirar. */
function exampleOf(type: GraphQLInputType, depth: number): unknown {
  if (isNonNullType(type)) return exampleOf(type.ofType, depth);
  if (isListType(type)) return [exampleOf(type.ofType, depth)];
  if (isEnumType(type)) return type.getValues()[0]?.name ?? "";
  if (isInputObjectType(type)) {
    if (depth <= 0) return {};
    return Object.fromEntries(
      Object.values(type.getFields())
        .filter((field) => isNonNullType(field.type) && field.defaultValue === undefined)
        .map((field) => [field.name, exampleOf(field.type, depth - 1)]),
    );
  }
  switch (type.name) {
    case "Int":
    case "Float":
      return 0;
    case "Boolean":
      return false;
    default:
      return "";
  }
}

/** Cuántos tipos propios tiene: los que empiezan por `__` son de la introspección, no de la API. */
export const typeCount = (schema: GraphQLSchema): number =>
  Object.keys(schema.getTypeMap()).filter((name) => !name.startsWith("__")).length;
