/**
 * Pedir la fusión de una copia en su original: sin título no se pide nada; mientras se crea lo dice,
 * al crearla se va a la solicitud en el original, y un rechazo del servidor se queda en el diálogo.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CreateMergeRequestModal } from "@/components/merge-request-modal";
import { ToastProvider } from "@/components/toast";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

function mount() {
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/p/fork"]}>
          <Routes>
            <Route
              path="/p/fork"
              element={
                <CreateMergeRequestModal forkId="fork" parent={{ id: "orig", name: "Tienda" }} onClose={onClose} />
              }
            />
            <Route path="/p/orig/merge-requests/:id" element={<p>solicitud abierta</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return onClose;
}

const submit = () => screen.getByRole("button", { name: /Crear solicitud|Creando…/ });

describe("pedir la fusión", () => {
  test("sin título el botón está apagado y enviar el formulario no pide nada", () => {
    call.mockReset();
    mount();
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(submit().closest("form")!);
    expect(call).not.toHaveBeenCalled();
  });

  test("crea la solicitud con título limpio y descripción, y va a ella", async () => {
    call.mockReset();
    let done: (value: unknown) => void = () => {};
    call.mockReturnValue(new Promise((resolve) => (done = resolve)));
    const onClose = mount();
    fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "  Añade pedidos  " } });
    fireEvent.change(screen.getAllByRole("textbox")[1]!, { target: { value: "Porque sí" } });
    fireEvent.click(submit());
    expect(await screen.findByRole("button", { name: "Creando…" })).toBeTruthy();
    expect(call).toHaveBeenCalledWith("/orgs/o/projects/fork/merge-requests", {
      method: "POST",
      body: { title: "Añade pedidos", description: "Porque sí" },
    });
    done({ id: "mr1" });
    expect(await screen.findByText("solicitud abierta")).toBeTruthy();
    expect(onClose).toHaveBeenCalled();
  });

  test("un rechazo del servidor se queda en el diálogo", async () => {
    call.mockReset();
    call.mockRejectedValue(new Error("No hay nada que fusionar"));
    mount();
    fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "Algo" } });
    fireEvent.click(submit());
    expect(await screen.findByText("No hay nada que fusionar")).toBeTruthy();
  });

  test("«Cancelar» cierra", () => {
    const onClose = mount();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onClose).toHaveBeenCalled();
  });
});
