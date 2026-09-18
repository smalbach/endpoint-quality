import { describe, expect, test } from "vitest";
import { buildSchema } from "graphql";

import { applyGraphqlSuggestion, suggestionsAt } from "@/lib/graphql-suggestions";

const schema = buildSchema(`
  type User {
    "El identificador"
    id: ID!
    name: String
    nickname: String @deprecated(reason: "usa name")
    posts(first: Int, order: Order): [Post!]!
  }
  type Post { id: ID! title: String author: User }
  "Cómo se ordena"
  enum Order { "De menos a más" ASC DESC }
  input Filter { role: Order text: String }
  type Query { user(id: ID!, filter: Filter): User users: [User!]! }
  type Mutation { rename(id: ID!, name: String!): User }
  directive @cached on FIELD
`);

/** La operación con `|` donde está el cursor. */
function at(marked: string) {
  const offset = marked.indexOf("|");
  const query = marked.replace("|", "");
  return { query, offset, found: suggestionsAt(schema, query, offset) };
}

const labels = (marked: string) => at(marked).found.items.map((item) => item.label);

describe("qué se ofrece donde está el cursor", () => {
  test("los campos raíz en la selección de la operación, filtrados por lo escrito", () => {
    expect(labels("{ |}")).toEqual(expect.arrayContaining(["user", "users", "__typename"]));
    expect(labels("query { us|}")).toEqual(["user", "users"]);
    expect(labels("mutation { |}")).toContain("rename");
    expect(labels("mutation { |}")).not.toContain("user");
  });

  test("en una selección anidada, los campos del tipo de esa selección, con su tipo y su descripción", () => {
    const { found } = at("{ user(id: 1) { posts { author { | } } } }");
    expect(found.items.map((item) => item.label)).toEqual(expect.arrayContaining(["id", "name", "posts"]));
    const id = found.items.find((item) => item.label === "id");
    expect(id).toMatchObject({ type: "ID!", description: "El identificador", insert: "id" });
    expect(labels("{ user(id: 1) { posts { | } } }")).toEqual(expect.arrayContaining(["id", "title", "author"]));
  });

  test("lo que empieza por lo escrito va primero; lo que lo contiene, después", () => {
    expect(labels("{ user(id: 1) { na| } }")[0]).toBe("name");
    expect(labels("{ user(id: 1) { d| } }")).toEqual(["id"]);
  });

  test("dentro de `(`, los argumentos, que se escriben con sus dos puntos", () => {
    const { found } = at("{ user(|) }");
    expect(found.items.map((item) => item.label)).toEqual(["id", "filter"]);
    expect(found.items[0]).toMatchObject({ type: "ID!", insert: "id: " });
    expect(labels("{ user(id: 1) { posts(f|) } }")).toEqual(["first"]);
    // Con los dos puntos ya escritos detrás, solo el nombre.
    expect(at("{ user(i|: 1) }").found.items[0].insert).toBe("id");
  });

  test("los campos de un input y los valores de un enum", () => {
    expect(labels("{ user(id: 1, filter: { | }) { id } }")).toEqual(["role", "text"]);
    const { found } = at("{ user(id: 1) { posts(order: |) { id } } }");
    expect(found.items.map((item) => item.label)).toEqual(["ASC", "DESC"]);
    expect(found.items[0]).toMatchObject({ type: "Order", description: "De menos a más" });
    expect(labels("{ user(id: 1, filter: { role: D| }) { id } }")).toEqual(["DESC"]);
  });

  test("los tipos después de `$x:`, y las variables declaradas después de `$`", () => {
    expect(labels("query Q($id: |) { user(id: $id) { id } }")).toEqual(
      expect.arrayContaining(["ID", "String", "Filter", "Order"]),
    );
    expect(labels("query Q($f: Fi|) { users { id } }")).toEqual(["Filter"]);

    const { query, found } = at("query Q($userId: ID!) {\n  user(id: $u|) { id }\n}");
    expect(found.items.map((item) => item.label)).toEqual(["$userId"]);
    const applied = applyGraphqlSuggestion(query, found, found.items[0]);
    expect(applied.text).toBe("query Q($userId: ID!) {\n  user(id: $userId) { id }\n}");
    expect(applied.caret).toBe(applied.text.indexOf(") { id }"));
  });

  test("las directivas después de `@`", () => {
    expect(labels("{ users @ca| { id } }")).toEqual(["cached"]);
  });

  test("al principio, las operaciones y no las palabras de un SDL", () => {
    const top = labels("|");
    expect(top).toEqual(expect.arrayContaining(["query", "mutation", "fragment"]));
    expect(top).not.toContain("type");
    expect(top).not.toContain("{");
  });

  test("aceptar sustituye la palabra entera y deja el cursor detrás", () => {
    const { query, found } = at("{ user(id: 1) { na|x } }");
    expect(found.word).toBe("nax");
    const name = found.items.find((item) => item.label === "name")!;
    expect(applyGraphqlSuggestion(query, found, name)).toEqual({ text: "{ user(id: 1) { name } }", caret: 20 });
  });
});

describe("lo que no ofrece nada", () => {
  test("sin esquema no hay sugerencias, y no falla", () => {
    expect(suggestionsAt(null, "{ us", 4).items).toEqual([]);
  });

  test("una `{{plantilla}}` no hace perder el contexto de lo que viene detrás", () => {
    expect(labels("{ user(id: {{userId}}) { na| } }")[0]).toBe("name");
    expect(labels('{ user(id: "{{userId}}") { | } }')).toContain("posts");
    // Una plantilla sin cerrar tampoco la rompe.
    expect(() => at("{ user(id: {{userId) { | } }")).not.toThrow();
  });

  test("con el cursor dentro de una plantilla, nada: ahí sugiere el entorno", () => {
    expect(labels("{ user(id: {{us|}}) { id } }")).toEqual([]);
    expect(labels("{ user(id: {{|")).toEqual([]);
  });

  test("en un comentario o en una cadena, nada", () => {
    expect(labels("# { us|")).toEqual([]);
    expect(labels('{ user(id: "us|") { id } }')).toEqual([]);
  });
});
