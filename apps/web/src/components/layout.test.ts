/**
 * The project tabs point inside the project.
 *
 * Small enough to look obviously right and it was wrong for two phases. The tabs were relative
 * paths — `to="runs"` — and react-router resolves those against **the route the link is rendered
 * in**, not the URL in the address bar. This layout is mounted at `/`, so `runs` became `/runs`,
 * which matches no route, falls to the catch-all and redirects to the project list. Three of the
 * four tabs threw you out of the project instead of navigating within it.
 *
 * Nothing caught it: the suite tests the session client and the bundle, and every screen was
 * reached in manual checks through the buttons that navigate with a full path. Clicking a tab is
 * what found it. So the paths are built by a function that can be asserted on without a router,
 * which is the cheapest place to keep this honest.
 */
import { describe, expect, test } from "vitest";
import { projectTabs } from "./layout";

describe("las pestañas de un proyecto", () => {
  const tabs = projectTabs("11111111-2222-3333-4444-555555555555");

  test("todas apuntan dentro del proyecto", () => {
    // The assertion that would have failed before: not one of them may be a bare `/runs`.
    for (const tab of tabs) expect(tab.to).toMatch(/^\/p\/11111111-2222-3333-4444-555555555555(\/|$)/);
  });

  test("son las cuatro, en orden, con sus destinos", () => {
    expect(tabs.map((tab) => [tab.label, tab.to])).toEqual([
      ["Matriz", "/p/11111111-2222-3333-4444-555555555555"],
      ["Entornos", "/p/11111111-2222-3333-4444-555555555555/environments"],
      ["Configuración", "/p/11111111-2222-3333-4444-555555555555/config"],
      ["Corridas", "/p/11111111-2222-3333-4444-555555555555/runs"],
    ]);
  });

  test("solo la matriz es coincidencia exacta", () => {
    // Without `end`, the project root would light up as active on every sub-route, so two tabs
    // would look selected at once.
    expect(tabs.filter((tab) => tab.end).map((tab) => tab.label)).toEqual(["Matriz"]);
  });

  test("sin proyecto no hay pestañas que enseñar", () => {
    // The project list has no project to be inside. Tabs there would point at whichever one was
    // last open, which is worse than none.
    expect(projectTabs(undefined)).toEqual([]);
  });
});
