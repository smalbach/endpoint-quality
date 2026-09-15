/**
 * The editor's half of the `graphql` node: what lands on the canvas and what the flow warns about.
 *
 * The variables check is the engine's (`graphqlVariablesProblem` in runner-core), written again
 * because the contract package emits no runtime. Same rule: every `{{template}}` stands in for a
 * value — a letter inside a string, `null` outside one — and what is left has to parse as a JSON
 * object. A text that only breaks once its values are in is the run's to report.
 */

/** What a freshly dropped node asks: valid against any schema, and it shows the node works. */
export const DEFAULT_GRAPHQL_QUERY = "query {\n  __typename\n}";

function withoutTemplates(text: string): string {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (text.startsWith("{{", index)) {
      const end = text.indexOf("}}", index + 2);
      if (end !== -1) {
        out += inString ? "x" : "null";
        index = end + 1;
        continue;
      }
    }
    if (inString && char === "\\") {
      out += char + (text[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (char === '"') inString = !inString;
    out += char;
  }
  return out;
}

/** Why a GraphQL node's variables cannot become a JSON object, or null. Blank sends none. */
export function graphqlVariablesProblem(text: string | undefined): string | null {
  if (!text?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutTemplates(text));
  } catch {
    return "Las variables no son JSON válido.";
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? null : "Las variables tienen que ser un objeto JSON.";
}

/** GraphQL's `Name` grammar, which an `operationName` has to follow. */
export const GRAPHQL_OPERATION_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;
