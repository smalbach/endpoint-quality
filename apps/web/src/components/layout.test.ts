/**
 * The project sections point inside the project.
 *
 * Small enough to look obviously right and it was wrong for two phases. The tabs were relative
 * paths — `to="runs"` — and react-router resolves those against **the route the link is rendered
 * in**, not the URL in the address bar, so three of the original tabs threw you out of the project
 * instead of navigating within it. So the paths are built by a function that can be asserted on
 * without a router, which is the cheapest place to keep this honest.
 */
import { describe, expect, test } from "vitest";
import { helpTopicFor, projectSections } from "./layout";
import { settingsTabs } from "@/routes/project-settings";

const ID = "11111111-2222-3333-4444-555555555555";

describe("las secciones de un proyecto", () => {
  const sections = projectSections(ID);

  test("todas apuntan dentro del proyecto", () => {
    for (const section of sections) expect(section.to).toMatch(new RegExp(`^/p/${ID}(/|$)`));
  });

  test("están en el orden del analizador y tienen sus destinos", () => {
    expect(sections.map((section) => [section.label, section.to])).toEqual([
      ["Endpoints", `/p/${ID}`],
      ["Roles", `/p/${ID}/roles`],
      ["Test Runs", `/p/${ID}/runs`],
      ["Flow Testing", `/p/${ID}/workflows`],
      ["Settings", `/p/${ID}/settings`],
    ]);
  });

  test("solo Endpoints es coincidencia exacta", () => {
    // Without `end`, the project root would light up on every sub-route, so two entries would
    // look selected at once.
    expect(sections.filter((section) => section.end).map((section) => section.label)).toEqual(["Endpoints"]);
  });

  test("sin proyecto no hay secciones que enseñar", () => {
    expect(projectSections(undefined)).toEqual([]);
  });

  test("la ayuda se abre en el tema de la sección que se está mirando", () => {
    expect(helpTopicFor(sections, `/p/${ID}`)).toBe("endpoints");
    expect(helpTopicFor(sections, `/p/${ID}/runs/abc`)).toBe("test-runs");
    expect(helpTopicFor(sections, `/p/${ID}/settings/environments`)).toBe("settings");
    expect(helpTopicFor(sections, "/projects")).toBe("primeros-pasos");
  });
});

describe("las pestañas de settings", () => {
  test("apuntan dentro de settings del proyecto", () => {
    expect(settingsTabs(ID).map((tab) => tab.to)).toEqual([
      `/p/${ID}/settings`,
      `/p/${ID}/settings/contract`,
      `/p/${ID}/settings/environments`,
    ]);
  });
});
