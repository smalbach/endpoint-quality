import assert from "node:assert/strict";
import test from "node:test";
import {
  interpolateText,
  interpolateValue,
  unresolvedVariables,
  valueAtPath,
  VARIABLE_NAME,
} from "../src/variables.ts";

test("interpolates variables recursively and leaves unknown tokens visible", () => {
  const value = interpolateValue(
    { path: "/users/{{ userId }}", body: { tenant: "{{tenant}}", unknown: "{{missing}}" } },
    { userId: "42", tenant: "acme" },
  );
  assert.deepEqual(value, { path: "/users/42", body: { tenant: "acme", unknown: "{{missing}}" } });
  assert.equal(interpolateText("{{userId}}", { userId: "42" }), "42");
});

test("finds unresolved variables even after URL encoding", () => {
  assert.deepEqual(unresolvedVariables({ path: "/users/%7B%7BuserId%7D%7D", body: { tenant: "{{tenant}}" } }), [
    "userId",
    "tenant",
  ]);
});

test("reads nested response values", () => {
  assert.equal(valueAtPath({ data: { items: [{ id: 7 }] } }, "data.items.0.id"), 7);
  assert.equal(valueAtPath({}, "data.id"), undefined);
});

test("a percent-encoded token is reported unresolved even though it can no longer be replaced", () => {
  // The asymmetry is the point: `requestPathFor` encodes after substitution, so `%7B%7Bx%7D%7D`
  // is past saving — but it is still a variable nobody supplied, and the step must be blocked
  // rather than sent with braces in the URL.
  const encoded = "/users/%7B%7BuserId%7D%7D";
  assert.equal(interpolateText(encoded, { userId: "42" }), encoded);
  assert.deepEqual(unresolvedVariables(encoded), ["userId"]);
});

test("the name rule is one regexp, and the token grammar agrees with it", () => {
  assert.ok(VARIABLE_NAME.test("user.id-2"));
  assert.equal(VARIABLE_NAME.test("2users"), false);
  assert.equal(interpolateText("{{user.id-2}}", { "user.id-2": "ok" }), "ok");
});
