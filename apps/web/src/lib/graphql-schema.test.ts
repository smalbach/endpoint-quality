import { describe, expect, test } from "vitest";
import { buildSchema, graphqlSync, introspectionFromSchema } from "graphql";

import {
  INTROSPECTION_QUERY,
  operationFor,
  queryProblems,
  rootFields,
  schemaFromIntrospection,
  schemaFromSdl,
  schemaFromText,
  typeCount,
} from "@/lib/graphql-schema";

const SDL = `
  "Un usuario"
  type User { id: ID! name: String posts(first: Int): [Post!]! friends(min: Int!): [User] }
  type Post { id: ID! title: String author: User }
  enum Role { ADMIN READER }
  input NewUser { name: String! role: Role! note: String }
  type Query {
    "Uno por id"
    user(id: ID!): User
    users(first: Int = 10): [User!]!
    old: String @deprecated(reason: "no")
  }
  type Mutation { createUser(input: NewUser!, dryRun: Boolean): User }
`;

const schema = buildSchema(SDL);

describe("de dónde sale el esquema", () => {
  test("la respuesta de la introspección, la que contesta el servidor a INTROSPECTION_QUERY", () => {
    const answer = graphqlSync({ schema, source: INTROSPECTION_QUERY });
    const read = schemaFromIntrospection(JSON.stringify(answer));
    expect(read.ok).toBe(true);
    if (read.ok) expect(rootFields(read.schema).map((field) => field.name)).toContain("createUser");
  });

  test("una introspección guardada sin el `data` de fuera también vale", () => {
    const read = schemaFromText(JSON.stringify(introspectionFromSchema(schema)));
    expect(read.ok).toBe(true);
  });

  test("la introspección apagada se dice con el mensaje del servidor", () => {
    const read = schemaFromIntrospection({ errors: [{ message: "GraphQL introspection is not allowed" }] });
    expect(read).toEqual({ ok: false, problem: "El servidor no dio su esquema: GraphQL introspection is not allowed" });
    const html = schemaFromIntrospection("<html>");
    expect(html.ok).toBe(false);
  });

  test("un SDL roto dice la línea", () => {
    const read = schemaFromSdl("type Query {\n  a: \n}");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.problem).toMatch(/línea 3/);
  });

  test("cuenta los tipos de la API y no los de la introspección", () => {
    // User, Post, Role, NewUser, Query, Mutation y los cuatro escalares que usa (sin `Float`).
    expect(typeCount(schema)).toBe(10);
  });
});

describe("la operación contra el esquema", () => {
  test("sin esquema, solo la sintaxis; con esquema, los campos y los tipos", () => {
    expect(queryProblems(null, "{ user(id: 1) { name }")).toHaveLength(1);
    expect(queryProblems(null, "{ nada }")).toEqual([]);
    const problems = queryProblems(schema, "{ user(id: 1) { nme } }");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ line: 1, column: 17 });
    expect(problems[0]!.message).toMatch(/nme/);
  });

  test("una plantilla suelta solo se mira por sintaxis; dentro de una cadena es texto", () => {
    expect(queryProblems(schema, "{ user(id: {{id}}) { name } }")).toEqual([]);
    expect(queryProblems(schema, '{ user(id: "{{id}}") { nombre } }')).toHaveLength(1);
  });
});

describe("lo que ofrece el esquema", () => {
  test("los campos raíz, con sus argumentos y su tipo", () => {
    const user = rootFields(schema).find((field) => field.name === "user");
    expect(user).toEqual({
      operation: "query",
      name: "user",
      description: "Uno por id",
      args: [{ name: "id", type: "ID!", required: true }],
      type: "User",
      deprecated: false,
    });
    expect(rootFields(schema).find((field) => field.name === "old")?.deprecated).toBe(true);
  });

  test("una operación generada valida contra su propio esquema, con los obligatorios como variables", () => {
    const generated = operationFor(schema, "query", "user");
    expect(generated).not.toBeNull();
    if (!generated) return;
    expect(generated.query).toMatch(/^query User\(\$id: ID!\) \{\n {2}user\(id: \$id\) \{/);
    // Dos niveles, y un campo con un argumento obligatorio (`friends`) fuera.
    expect(generated.query).toMatch(/posts \{\n\s+id\n\s+title\n\s+\}/);
    expect(generated.query).not.toMatch(/friends/);
    expect(JSON.parse(generated.variables)).toEqual({ id: "" });
    expect(queryProblems(schema, generated.query)).toEqual([]);
  });

  test("una mutación con un input: los campos obligatorios, el enum con su primer valor", () => {
    const generated = operationFor(schema, "mutation", "createUser");
    expect(generated?.query).toMatch(/^mutation CreateUser\(\$input: NewUser!\)/);
    expect(JSON.parse(generated!.variables)).toEqual({ input: { name: "", role: "ADMIN" } });
    expect(queryProblems(schema, generated!.query)).toEqual([]);
  });

  test("sin argumentos obligatorios no hay variables, y un campo que no existe no genera nada", () => {
    expect(operationFor(schema, "query", "users")?.variables).toBe("");
    expect(operationFor(schema, "query", "nadie")).toBeNull();
  });
});

describe("lo que no se deja leer", () => {
  test("un JSON sin `__schema` ni `errors` pide el SDL", () => {
    expect(schemaFromIntrospection({ data: null })).toEqual({
      ok: false,
      problem:
        "La respuesta no trae «__schema»: puede que la introspección esté apagada. Carga el SDL desde un fichero",
    });
    // `errors` que no es una lista, o sin mensajes de texto: igual que sin errores.
    const noMessage = schemaFromIntrospection({ errors: [{ message: 3 }, "x"] });
    expect(noMessage.ok).toBe(false);
    if (!noMessage.ok) expect(noMessage.problem).toMatch(/Carga el SDL/);
    expect(schemaFromIntrospection({ errors: "apagada" })).toEqual(noMessage);
  });

  test("un `__schema` a medias dice por qué no vale", () => {
    const read = schemaFromIntrospection({ data: { __schema: {} } });
    expect(read.ok).toBe(false);
    // Sin tipos no hay de dónde construirlo; es un error de JavaScript, sin línea.
    if (!read.ok) {
      expect(read.problem).toMatch(/^El esquema no se pudo leer: \S/);
      expect(read.problem).not.toMatch(/línea/);
    }
  });

  test("un valor por defecto roto en la introspección dice su línea", () => {
    const saved = introspectionFromSchema(schema) as unknown as {
      __schema: {
        types: { name: string; fields: { name: string; args: { defaultValue: string | null }[] }[] | null }[];
      };
    };
    const query = saved.__schema.types.find((type) => type.name === "Query")!;
    query.fields!.find((field) => field.name === "users")!.args[0]!.defaultValue = "{";
    const read = schemaFromIntrospection(saved);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.problem).toMatch(/^El esquema no se pudo leer: .*\(línea 1, columna 2\)$/);
  });

  test("un fichero vacío, y uno de SDL", () => {
    expect(schemaFromText("  \n ")).toEqual({ ok: false, problem: "El fichero está vacío" });
    const sdl = schemaFromText("\n type Query { a: Int }\n");
    expect(sdl.ok).toBe(true);
    if (sdl.ok) expect(rootFields(sdl.schema).map((field) => field.name)).toEqual(["a"]);
  });

  test("un SDL que nombra un tipo que no existe no tiene línea en el mensaje", () => {
    const read = schemaFromSdl("type Query { a: Nada }");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.problem).toMatch(/^El SDL no se pudo leer: .*Nada/);
  });
});

describe("la operación contra un esquema raro", () => {
  test("una operación vacía no tiene problemas", () => {
    expect(queryProblems(schema, "  \n")).toEqual([]);
  });

  test("un esquema que se deja construir pero no es válido no tumba el editor: lo dice", () => {
    const broken = buildSchema("type Query { a: I } interface I { x: Int } type T implements I { y: Int }");
    const problems = queryProblems(broken, "{ a { x } }");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ line: null, column: null });
    expect(problems[0]!.message).toMatch(/Interface field I\.x expected but T does not provide it/);
  });
});

describe("lo que se genera en los bordes", () => {
  const odd = buildSchema(`
    interface Node { id: ID! }
    type Thing implements Node { id: ID! old: Int @deprecated(reason: "no") }
    type Bare { needs(x: Int!): Int }
    type Empty { needs(x: Int!): Int deep: Bare }
    union Any = Thing
    enum Nothing
    input Level3 { n: Int! }
    input Level2 { l: Level3! }
    input Level1 { l: Level2! }
    input Top { l: Level1! f: Float! b: Boolean! s: String! }
    type Query {
      node(ids: [ID!]!, count: Int!, top: Top!, none: Nothing!): Node
      any: Any
      empty: Empty
      scalar: String
    }
    type Subscription { ticked: Thing }
  `);

  test("una suscripción, con su selección", () => {
    expect(operationFor(odd, "subscription", "ticked")?.query).toBe(
      "subscription Ticked {\n  ticked {\n    id\n  }\n}",
    );
    expect(operationFor(odd, "mutation", "ticked")).toBeNull();
  });

  test("un campo hoja no lleva selección; una unión pide `__typename`", () => {
    expect(operationFor(odd, "query", "scalar")?.query).toBe("query Scalar {\n  scalar\n}");
    expect(operationFor(odd, "query", "any")?.query).toBe("query Any {\n  any {\n    __typename\n  }\n}");
  });

  test("una interfaz enseña sus campos; un tipo sin nada que pedir, `__typename`", () => {
    const node = operationFor(odd, "query", "node")!;
    expect(node.query).toMatch(/node\(ids: \$ids, count: \$count, top: \$top, none: \$none\) \{\n {4}id\n {2}\}/);
    // `needs` tiene un argumento obligatorio y `Bare` no tiene nada más que pedir: queda `__typename`.
    expect(operationFor(odd, "query", "empty")?.query).toBe(
      "query Empty {\n  empty {\n    deep {\n      __typename\n    }\n  }\n}",
    );
  });

  test("los valores de ejemplo: listas, números, booleanos, un enum sin valores y el fondo de los inputs", () => {
    const node = operationFor(odd, "query", "node")!;
    expect(JSON.parse(node.variables)).toEqual({
      ids: [""],
      count: 0,
      top: { l: { l: { l: {} } }, f: 0, b: false, s: "" },
      none: "",
    });
  });
});
