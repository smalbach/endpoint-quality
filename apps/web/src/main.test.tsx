/**
 * El punto de entrada: monta la app en `#root`, bajo un router del navegador y con un cliente de
 * consultas nuevo. Todo lo demás está en `@/app` y tiene sus pruebas.
 */
import { expect, test, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";

const received = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/app", () => ({
  createQueryClient: () => new QueryClient(),
  App: ({ client }: { client: unknown }) => {
    received.client = client;
    return <p>app en {useLocation().pathname}</p>;
  },
}));

test("monta la app en #root con el router del navegador y su cliente", async () => {
  window.history.pushState({}, "", "/projects");
  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);

  await act(async () => {
    await import("./main");
  });

  await waitFor(() => expect(screen.getByText("app en /projects")).toBeTruthy());
  expect(root.textContent).toBe("app en /projects");
  expect(received.client).toBeInstanceOf(QueryClient);
});
