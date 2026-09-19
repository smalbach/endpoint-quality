/**
 * El traductor de scripts de Postman, por sus bordes: cada forma en que se rinde (y dice por qué) y
 * cada forma que sí sabe leer. Complementa `postman-flows.test.ts`, que fija el caso típico.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  bodyPath,
  literalOf,
  splitStatements,
  splitTop,
  stripComments,
  translatePostmanScript,
} from "@/modules/workflows/domain/postman-scripts";

const J = "const j = pm.response.json();\n";
const t = (code: string) => translatePostmanScript(code);
/** The single check a script produces; fails when it is not fully understood. */
const onlyCheck = (code: string) => {
  const out = t(code);
  assert.equal(out.untranslatable, null, `expected ${code} to translate`);
  assert.equal(out.checks.length, 1);
  return out.checks[0];
};
const refused = (code: string) => {
  const out = t(code);
  assert.notEqual(out.untranslatable, null, `expected ${code} to be refused`);
  assert.deepEqual(out.checks, []);
  assert.deepEqual(out.captures, []);
  return out.untranslatable as string;
};

describe("translatePostmanScript — the whole script", () => {
  test("an empty or blank script is understood and declares nothing", () => {
    assert.deepEqual(t("   \n  "), { checks: [], captures: [], untranslatable: null });
  });

  test("a pm.test without its closing parenthesis cannot be cut", () => {
    assert.equal(refused('pm.test("abierto", function () {'), "un pm.test sin cerrar");
  });

  test("a pm.test whose name is not a literal, or missing, is refused", () => {
    assert.equal(refused("pm.test(nombre, function () { pm.response.to.have.status(200); })"), "un pm.test sin nombre literal");
    assert.equal(refused("pm.test()"), "un pm.test sin nombre literal");
  });

  test("a pm.test whose callback is not an inline function is refused by name", () => {
    assert.equal(refused('pm.test("ref", comprobar)'), "pm.test «ref» no lleva una función que se pueda leer");
    assert.equal(
      refused('pm.test("llamada", envolver({}))'),
      "pm.test «llamada» no lleva una función que se pueda leer",
    );
  });

  test("arrow, single-parameter and async callbacks are all readable", () => {
    for (const head of ["() =>", "x =>", "async () =>", "async function named()"]) {
      const check = onlyCheck(`pm.test("t", ${head} { pm.response.to.have.status(204) })`);
      assert.deepEqual(check, { label: "t", source: "status", operator: "equals", value: 204 });
    }
  });

  test("a pm.test that only logs is refused: its claim would silently vanish", () => {
    assert.equal(
      refused('pm.test("solo log", function () { console.log("hola"); })'),
      "pm.test «solo log» no declara nada reconocible",
    );
  });

  test("more than fifty checks keep the script instead of truncating it", () => {
    const lines = Array.from({ length: 51 }, () => "pm.response.to.have.status(200);").join("\n");
    assert.equal(refused(lines), "el script declara 51 comprobaciones");
    const fifty = t(Array.from({ length: 50 }, () => "pm.response.to.have.status(200);").join("\n"));
    assert.equal(fifty.untranslatable, null);
    assert.equal(fifty.checks.length, 50);
  });

  test("the unreadable statement is quoted, cut at 120 characters", () => {
    const long = `pm.sendRequest("${"x".repeat(200)}")`;
    const reason = refused(long);
    assert.ok(reason.endsWith("…"));
    assert.equal(reason, `${long.slice(0, 120).trim()}…`);
    assert.equal(refused("pm.sendRequest('corto')"), "pm.sendRequest('corto')");
  });

  test("a blank or whitespace-only test name gives an unlabelled check; a long one is cut to 120", () => {
    assert.deepEqual(onlyCheck('pm.test("   ", () => { pm.response.to.have.status(200) })'), {
      source: "status",
      operator: "equals",
      value: 200,
    });
    const name = "n".repeat(150);
    assert.equal(onlyCheck(`pm.test("${name}", () => { pm.response.to.have.status(200) })`).label, "n".repeat(120));
  });

  test("a nested pm.test is not read", () => {
    const reason = refused('pm.test("a", function () { pm.test("b", function () { pm.response.to.have.status(200) }) })');
    assert.match(reason, /^pm\.test\("b"/);
  });

  test("loose statements before and after tests are kept in order, strings with escapes do not confuse the cutter", () => {
    const out = t(
      [
        'console.log("q\\"(pm.test(");',
        'pm.test("uno \\" dos", () => { pm.response.to.have.status(201) })',
        'pm.environment.set("after", pm.response.json().id)',
      ].join("\n"),
    );
    assert.equal(out.untranslatable, null);
    assert.deepEqual(out.checks, [{ label: 'uno " dos', source: "status", operator: "equals", value: 201 }]);
    assert.deepEqual(out.captures, [{ variable: "after", from: "body", path: "id" }]);
  });
});

describe("translatePostmanScript — bindings", () => {
  test("a binding to something that is not the body is refused", () => {
    assert.equal(refused("const x = 5"), "const x = 5");
  });

  test("JSON.parse(pm.response.text()) binds the root", () => {
    assert.deepEqual(onlyCheck("var b = JSON.parse(pm.response.text());\npm.expect(b.ok).to.be.true"), {
      source: "body",
      path: "ok",
      operator: "equals",
      value: true,
    });
  });

  test("a sub-path binding and a chained binding extend the path", () => {
    assert.deepEqual(
      onlyCheck("const data = pm.response.json().data\nconst rows = data.items\npm.expect(rows[0].id).to.exist"),
      { source: "body", path: "data.items.0.id", operator: "exists" },
    );
  });

  test("an unqualified reassignment rebinds the name, or refuses when it points elsewhere", () => {
    assert.deepEqual(onlyCheck("let j = pm.response.json()\nj = pm.response.json().data\npm.expect(j.id).to.exist"), {
      source: "body",
      path: "data.id",
      operator: "exists",
    });
    assert.equal(refused("let j = pm.response.json()\nj = 5"), "j = 5");
  });
});

describe("translatePostmanScript — captures", () => {
  test("every store is a capture", () => {
    for (const store of ["environment", "collectionVariables", "globals", "variables"]) {
      const out = t(`${J}pm.${store}.set("id", j.id)`);
      assert.deepEqual(out.captures, [{ variable: "id", from: "body", path: "id" }], store);
    }
  });

  test("a header capture, and a header capture with an empty name refused", () => {
    assert.deepEqual(t('pm.variables.set("total", pm.response.headers.get("X-Total"))').captures, [
      { variable: "total", from: "header", path: "X-Total" },
    ]);
    refused('pm.variables.set("total", pm.response.headers.get("  "))');
  });

  test("a capture needs a literal, well-formed name and a source", () => {
    refused(`${J}pm.environment.set(nombre, j.id)`);
    refused(`${J}pm.environment.set("1abc", j.id)`);
    refused('pm.environment.set("id")');
    refused(`${J}pm.environment.set("x", Date.now())`);
  });
});

describe("translatePostmanScript — pm.response.to", () => {
  test("status by number and by reason phrase", () => {
    assert.deepEqual(onlyCheck('pm.response.to.have.status("Created")'), {
      source: "status",
      operator: "equals",
      value: 201,
    });
    assert.equal(onlyCheck("pm.response.to.have.status(' Not Found ')").value, 404);
  });

  test("an unknown phrase, a non-literal or a negated status is refused", () => {
    refused('pm.response.to.have.status("Teapot")');
    refused("pm.response.to.have.status(code)");
    refused("pm.response.to.not.have.status(500)");
  });

  test("a header with and without value, negated or not", () => {
    assert.deepEqual(onlyCheck('pm.response.to.have.header("Content-Type", "application/json")'), {
      source: "header",
      path: "Content-Type",
      operator: "equals",
      value: "application/json",
    });
    assert.deepEqual(onlyCheck('pm.response.to.not.have.header("X-Debug", "1")'), {
      source: "header",
      path: "X-Debug",
      operator: "not_equals",
      value: "1",
    });
    assert.deepEqual(onlyCheck('pm.response.to.not.have.header(" X-Debug ")'), {
      source: "header",
      path: "X-Debug",
      operator: "not_exists",
    });
  });

  test("a header assertion with an unreadable name or value is refused", () => {
    refused("pm.response.to.have.header(nombre)");
    refused('pm.response.to.have.header("")');
    refused('pm.response.to.have.header("X", valor)');
  });

  test("a property assertion (not a call) or an unknown call is refused", () => {
    refused("pm.response.to.be.ok");
    refused("pm.response.to.have.jsonBody()");
  });
});

describe("translatePostmanScript — pm.expect", () => {
  test("the subject can be status, time, text, header or the body root", () => {
    assert.deepEqual(onlyCheck("pm.expect(pm.response.code).to.equal(200)"), {
      source: "status",
      operator: "equals",
      value: 200,
    });
    assert.equal(onlyCheck("pm.expect(pm.response.statusCode).to.eql(200)").source, "status");
    assert.deepEqual(onlyCheck('pm.expect(pm.response.text()).to.include("ok")'), {
      source: "body",
      operator: "contains",
      value: "ok",
    });
    assert.deepEqual(onlyCheck('pm.expect(pm.response.headers.get("ETag")).to.exist'), {
      source: "header",
      path: "ETag",
      operator: "exists",
    });
    assert.deepEqual(onlyCheck('pm.expect(pm.response.json()).to.be.an("array")'), {
      source: "body",
      operator: "is_array",
    });
  });

  test("an unknown subject, an unclosed expect or an ambiguous chain is refused", () => {
    refused("pm.expect(otra).to.exist");
    refused("handlers[0](1)");
    refused(`${J}pm.expect(j.a`);
    refused(`${J}pm.expect(j.a).to.be.ok.and.true`);
    refused(`${J}pm.expect(j.a).to.be.within(1, 2)`);
  });

  test("true and false, negated", () => {
    assert.deepEqual(onlyCheck(`${J}pm.expect(j.ok).to.not.be.false`), {
      source: "body",
      path: "ok",
      operator: "not_equals",
      value: false,
    });
  });

  test("not.empty is «trae algo»", () => {
    assert.deepEqual(onlyCheck(`${J}pm.expect(j.items).to.not.be.empty`), {
      source: "body",
      path: "items",
      operator: "is_not_empty",
    });
  });

  test("a/an only understands «array», never negated", () => {
    refused(`${J}pm.expect(j.x).to.be.an("object")`);
    refused(`${J}pm.expect(j.x).to.not.be.an("array")`);
    refused(`${J}pm.expect(j.x).to.be.a(tipo)`);
  });

  test("have.property grows the path, with or without a value, negated or not", () => {
    assert.deepEqual(onlyCheck(`${J}pm.expect(j.user).to.have.property("id")`), {
      source: "body",
      path: "user.id",
      operator: "exists",
    });
    assert.deepEqual(onlyCheck(`pm.expect(pm.response.json()).to.not.have.property("error")`), {
      source: "body",
      path: "error",
      operator: "not_exists",
    });
    assert.deepEqual(onlyCheck(`${J}pm.expect(j).to.have.property("estado", "ok")`), {
      source: "body",
      path: "estado",
      operator: "equals",
      value: "ok",
    });
    assert.deepEqual(onlyCheck(`${J}pm.expect(j).to.not.have.property("estado", 3)`), {
      source: "body",
      path: "estado",
      operator: "not_equals",
      value: 3,
    });
  });

  test("have.property is refused on a non-body subject or with unreadable arguments", () => {
    refused('pm.expect(pm.response.code).to.have.property("x")');
    refused(`${J}pm.expect(j).to.have.property(nombre)`);
    refused(`${J}pm.expect(j).to.have.property("")`);
    refused(`${J}pm.expect(j).to.have.property("x", valor)`);
  });

  test("argument-less operators and their negations", () => {
    assert.equal(onlyCheck(`${J}pm.expect(j.a).to.not.exist`).operator, "not_exists");
    assert.equal(onlyCheck(`${J}pm.expect(j.a).to.be.undefined`).operator, "not_exists");
    assert.equal(onlyCheck(`${J}pm.expect(j.a).to.not.be.undefined`).operator, "exists");
  });

  test("an operator with no negation is refused when negated", () => {
    refused(`${J}pm.expect(j.n).to.not.be.above(3)`);
  });

  test("the comparison operators", () => {
    assert.deepEqual(onlyCheck(`${J}pm.expect(j.n).to.be.gt(-1.5)`), {
      source: "body",
      path: "n",
      operator: "greater_than",
      value: -1.5,
    });
    assert.equal(onlyCheck(`${J}pm.expect(j.tags).to.not.include("x")`).operator, "not_contains");
    assert.deepEqual(onlyCheck(`${J}pm.expect(j.tags).to.eql(["a", 1])`).value, ["a", 1]);
    refused(`${J}pm.expect(j.n).to.equal(otro)`);
  });

  test("match takes a regex literal (flags dropped) or a quoted string", () => {
    assert.deepEqual(onlyCheck(`${J}pm.expect(j.code).to.match(/^ORD-\\d+/i)`), {
      source: "body",
      path: "code",
      operator: "matches",
      value: "^ORD-\\d+",
    });
    assert.equal(onlyCheck(`${J}pm.expect(j.code).to.match("^A")`).value, "^A");
  });

  test("match refuses an invalid pattern or a non-literal", () => {
    refused(`${J}pm.expect(j.code).to.match(/(/)`);
    refused(`${J}pm.expect(j.code).to.match("(")`);
    refused(`${J}pm.expect(j.code).to.match(patron)`);
  });

  test("a message argument is ignored and a string with escapes stays intact", () => {
    assert.deepEqual(onlyCheck(`${J}pm.expect(j.s, "mensaje").to.eql("a\\"b")`), {
      source: "body",
      path: "s",
      operator: "equals",
      value: 'a"b',
    });
  });
});

describe("postman-scripts helpers", () => {
  test("stripComments removes line and block comments but not what is inside strings", () => {
    assert.equal(stripComments('a // x\nb'), "a \nb");
    assert.equal(stripComments("a /* x */ b"), "a   b");
    assert.equal(stripComments("a /* never closed"), "a  ");
    assert.equal(stripComments('"http://x" \'a\\\'//\''), '"http://x" \'a\\\'//\'');
    assert.equal(stripComments("`//x`"), "`//x`");
    // A backslash at the very end of an open string does not read past the end.
    assert.equal(stripComments('"a\\'), '"a\\');
  });

  test("splitTop keeps separators inside brackets and quotes", () => {
    assert.deepEqual(splitTop('a,(b,c),[d,e],{f,g},"h,i",\'j\\\',k\'', ","), [
      "a",
      "(b,c)",
      "[d,e]",
      "{f,g}",
      '"h,i"',
      "'j\\',k'",
    ]);
    assert.deepEqual(splitTop('"x\\', ","), ['"x\\']);
  });

  test("splitStatements breaks on semicolons and newlines at the top level only", () => {
    assert.deepEqual(splitStatements("a; b\nc(\n1\n);;\n"), ["a", "b", "c(\n1\n)"]);
  });

  test("bodyPath walks dots and brackets, refuses the rest", () => {
    const names = new Map([["j", ""], ["d", "data"]]);
    assert.equal(bodyPath("j", names), "");
    assert.equal(bodyPath("d.items[0]['id']", names), "data.items.0.id");
    assert.equal(bodyPath('pm.response.json()["a"].b', names), "a.b");
    assert.equal(bodyPath("otra.a", names), null);
    assert.equal(bodyPath("(j)", names), null);
    assert.equal(bodyPath("j[i]", names), null);
    assert.equal(bodyPath("j.items.length > 0", names), null);
    assert.equal(bodyPath("j.a   ", names), "a");
  });

  test("literalOf reads every literal form and nothing else", () => {
    assert.equal(literalOf(""), undefined);
    assert.equal(literalOf("true"), true);
    assert.equal(literalOf("false"), false);
    assert.equal(literalOf("null"), null);
    assert.equal(literalOf("-12"), -12);
    assert.equal(literalOf("3.25"), 3.25);
    assert.equal(literalOf('"a\\nb"'), "a\nb");
    assert.equal(literalOf('"\\x"'), undefined);
    assert.deepEqual(literalOf('{"a": [1]}'), { a: [1] });
    assert.equal(literalOf("{a: 1}"), undefined);
    assert.equal(literalOf("'it\\'s'"), "it's");
    assert.equal(literalOf("'say \"hi\"'"), 'say "hi"');
    assert.equal(literalOf("`plain`"), "plain");
    assert.equal(literalOf("'\\x'"), undefined);
    assert.equal(literalOf("`${x}`"), undefined);
    assert.equal(literalOf("variable"), undefined);
  });
});
