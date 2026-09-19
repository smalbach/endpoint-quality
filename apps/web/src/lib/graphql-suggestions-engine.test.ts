import { describe, expect, test, vi } from "vitest";
import { buildSchema } from "graphql";
import type * as LanguageService from "graphql-language-service";

// El motor de GraphiQL, que aquí se rompe a propósito: lo que se prueba es que su excepción no
// llega al editor.
vi.mock("graphql-language-service", async (importOriginal) => ({
  ...(await importOriginal<typeof LanguageService>()),
  getAutocompleteSuggestions: () => {
    throw new Error("el motor no sabe qué hacer");
  },
}));

const { suggestionsAt } = await import("@/lib/graphql-suggestions");

describe("cuando el motor de autocompletado lanza", () => {
  test("no hay sugerencias, y el cursor se queda donde estaba", () => {
    const schema = buildSchema("type Query { a: Int }");
    expect(suggestionsAt(schema, "{ a }", 3)).toEqual({ from: 3, to: 3, word: "", items: [] });
  });
});
