/**
 * Qué ofrecer donde está el cursor de una operación GraphQL, con el esquema cargado.
 *
 * Es el autocompletado de Postman: los campos del tipo de la selección en la que se escribe, los
 * argumentos dentro de `(`, los campos de un input, los valores de un enum, los tipos después de
 * `$x:`, las variables declaradas después de `$` y las directivas después de `@`.
 *
 * El contexto lo decide `graphql-language-service`, el mismo motor de GraphiQL, y no un analizador
 * propio: una operación a medio escribir **no es GraphQL** —`{ user(id: 1) { na` no se deja
 * `parse`ar—, y su analizador es tolerante precisamente para eso: lee token a token hasta el cursor
 * y sabe en qué regla de la gramática está. Escribir eso encima de `graphql-js` era rehacerlo peor.
 * Vive, como `graphql`, en el trozo que solo se carga al abrir un cuerpo GraphQL.
 *
 * Aquí se decide lo que el motor no sabe de este editor: qué hacer con las `{{plantillas}}`, qué
 * texto sustituye la sugerencia y cuáles no tienen sentido en una operación (las palabras de SDL).
 */
import { getAutocompleteSuggestions, Position, type CompletionItem } from "graphql-language-service";

import type { GraphQLSchema } from "@/lib/graphql-schema";
import { openTokenAt } from "@/lib/variable-suggestions";

export type GraphqlSuggestion = {
  label: string;
  /** Lo que se escribe al aceptarla: `id: ` para un argumento, el nombre para un campo. */
  insert: string;
  /** El tipo, tal como se escribe en GraphQL: `[Post!]!`. Vacío cuando no lo tiene (un tipo, una directiva). */
  type: string;
  description: string;
  deprecated: boolean;
};

/** Las sugerencias y el trozo del texto que sustituyen: la palabra bajo el cursor, entera. */
export type GraphqlSuggestions = { from: number; to: number; word: string; items: GraphqlSuggestion[] };

const NONE = (offset: number): GraphqlSuggestions => ({ from: offset, to: offset, word: "", items: [] });

/**
 * Lo que el motor ofrece en un documento vacío y no se escribe en una operación: el editor manda
 * operaciones, no define esquemas. `{` sí es una operación, pero no es algo que se elija de una lista.
 */
const NOT_IN_OPERATIONS = new Set([
  "{",
  "extend",
  "schema",
  "scalar",
  "type",
  "interface",
  "union",
  "enum",
  "input",
  "directive",
]);

/** Cuántas se enseñan. La lista va encima de la operación: con más, tapa lo que se está escribiendo. */
const LIMIT = 50;

/** Una `{{plantilla}}` cerrada, se esté donde se esté: dentro de una cadena da igual con qué se tape. */
const TEMPLATE = /\{\{[^{}]*\}\}/g;

/**
 * Las sugerencias en `offset` (el `selectionStart` del cuadro de texto).
 *
 * Una `{{plantilla}}` no es GraphQL, y el analizador que tropieza con `{{` cree que se abren dos
 * selecciones y pierde el contexto de todo lo que viene detrás. Se tapa con un `0` y espacios —un
 * valor que el analizador acepta— **del mismo largo**, para que los desplazamientos sigan siendo
 * los del texto que se ve. Y con el cursor dentro de una plantilla no se ofrece nada: ahí sugiere
 * `VariableSuggest` los nombres del entorno, y dos listas a la vez no son de nadie.
 */
export function suggestionsAt(schema: GraphQLSchema | null, query: string, offset: number): GraphqlSuggestions {
  if (!schema || openTokenAt(query, offset)) return NONE(offset);
  const masked = query.replace(TEMPLATE, (template) => "0".padEnd(template.length, " "));

  const before = masked.slice(0, offset);
  // Las dos búsquedas siempre encuentran algo (como poco, el final del texto): no hay -1 que mirar.
  const prefix = before.slice(before.search(/[_A-Za-z0-9]*$/));
  const dollar = before.charAt(offset - prefix.length - 1) === "$";
  const from = offset - prefix.length - (dollar ? 1 : 0);
  const to = offset + masked.slice(offset).search(/[^_A-Za-z0-9]|$/);

  const line = before.split("\n").length - 1;
  const character = offset - (before.lastIndexOf("\n") + 1);
  let found: CompletionItem[];
  try {
    found = getAutocompleteSuggestions(schema, masked, new Position(line, character));
  } catch {
    // El motor es tolerante, pero no se le ha probado con todo lo que se puede teclear: una
    // excepción aquí no puede tumbar el editor. Sin sugerencias se sigue escribiendo.
    return NONE(offset);
  }

  const wanted = prefix.toLowerCase();
  const named = (item: CompletionItem) => item.label.replace(/^\$/, "").toLowerCase();
  const items = found
    .filter((item) => !NOT_IN_OPERATIONS.has(item.label) && named(item).includes(wanted))
    // Lo que empieza por lo escrito va antes, como en `suggestionsFor`; el resto conserva el orden
    // del motor, que pone los campos del tipo antes que `__typename`.
    .map((item, index) => ({ item, index, prefixed: named(item).startsWith(wanted) }))
    .sort((left, right) => Number(right.prefixed) - Number(left.prefixed) || left.index - right.index)
    .slice(0, LIMIT)
    .map(({ item }) => toSuggestion(item, masked.slice(to)));

  return { from, to, word: query.slice(from, to), items };
}

function toSuggestion(item: CompletionItem, after: string): GraphqlSuggestion {
  // Los argumentos y los campos de un input traen `nombre: ` (o un fragmento con `$1` de VS Code,
  // que aquí no se expande): se escribe `nombre: ` y se sigue con el valor. Si los dos puntos ya
  // están detrás, solo el nombre.
  const takesValue = item.insertText?.startsWith(`${item.label}:`) ?? false;
  const insert = takesValue && !/^\s*:/.test(after) ? `${item.label}: ` : item.label;
  const type = item.detail ?? (item.type ? String(item.type) : "");
  return {
    label: item.label,
    insert,
    type,
    description: item.documentation ?? "",
    deprecated: Boolean(item.isDeprecated),
  };
}

/** El texto con la sugerencia escrita en lugar de la palabra, y dónde queda el cursor: detrás. */
export function applyGraphqlSuggestion(
  text: string,
  at: Pick<GraphqlSuggestions, "from" | "to">,
  suggestion: GraphqlSuggestion,
): { text: string; caret: number } {
  return {
    text: `${text.slice(0, at.from)}${suggestion.insert}${text.slice(at.to)}`,
    caret: at.from + suggestion.insert.length,
  };
}
