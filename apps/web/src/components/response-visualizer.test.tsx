/**
 * La pestaña «Visualizar»: sin visualización explica cómo dibujar una; con ella, la dibuja en un
 * marco aislado (solo scripts, sin mismo origen) que lleva la plantilla y los datos.
 */
import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";

import ResponseVisualizer from "@/components/response-visualizer";

test("sin visualización explica cómo hacerla", () => {
  render(<ResponseVisualizer visualization={null} />);
  expect(screen.getByText(/Sin visualización/)).toBeTruthy();
  expect(screen.queryByTitle("Visualización")).toBeNull();
});

test("con visualización la dibuja en un marco aislado", () => {
  render(
    <ResponseVisualizer
      visualization={{ template: "<b>{{name}}</b>", data: { name: "Ana" }, options: {} } as never}
    />,
  );
  const frame = screen.getByTitle("Visualización") as HTMLIFrameElement;
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  const doc = frame.getAttribute("srcdoc")!;
  expect(doc).toContain('"\\u003cb>{{name}}\\u003c/b>"');
  expect(doc).toContain("Ana");
});
