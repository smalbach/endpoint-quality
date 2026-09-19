import { describe, expect, test } from "vitest";

import { graphqlVariablesProblem } from "@/lib/graphql-draft";

describe("las variables de un nodo GraphQL", () => {
  test("un escape dentro de una cadena no la cierra, ni tapa lo que viene detrás", () => {
    expect(graphqlVariablesProblem('{"a": "di \\"{{nombre}}\\" hola"}')).toBeNull();
    expect(graphqlVariablesProblem('{"a": "\\\\", "b": {{b}}}')).toBeNull();
  });

  test("una barra al final del texto, dentro de una cadena, no es JSON", () => {
    expect(graphqlVariablesProblem('{"a": "x\\')).toBe("Las variables no son JSON válido.");
  });
});
