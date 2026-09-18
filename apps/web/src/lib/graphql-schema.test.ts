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
