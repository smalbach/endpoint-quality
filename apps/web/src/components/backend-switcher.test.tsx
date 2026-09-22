/**
 * El selector de backend.
 *
 * Lo que importa afirmar no es que pinte tres botones: es que **sondea** en vez de fiarse de una
 * lista, que dice lo que cada backend no cubre **antes** de entrar, y que al cambiar recarga —
 * porque las respuestas cacheadas son de quien las contestó y enseñarlas bajo el nombre de otro
 * backend sería mentir con datos reales.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { BackendSwitcher } from "./backend-switcher";
import { DEFAULT_BACKEND, selectBackend, selectedBackendId, type ModuleCoverage } from "@/lib/backends";

const descriptorFor = (id: string, modules: Record<string, ModuleCoverage>) => ({
  id,
  name: id,
  runtime: `runtime de ${id}`,
  version: "0.1.0",
  reference: id === "node",
  modules,
});

/** Los tres contestando, salvo los que se declaren caídos. */
function stubBackends(options: { down?: string[]; modules?: Record<string, Record<string, ModuleCoverage>> } = {}) {
  const down = options.down ?? [];
  vi.stubGlobal("fetch", async (url: string) => {
    const id = url.startsWith("/api-py") ? "python" : url.startsWith("/api-go") ? "go" : "node";
    if (down.includes(id)) throw new TypeError("connection refused");
    const modules = options.modules?.[id] ?? { auth: "full" };
    return new Response(JSON.stringify(descriptorFor(id, modules)), { status: 200 });
  });
}

beforeEach(() => {
  window.localStorage.clear();
  selectBackend(DEFAULT_BACKEND);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("elegir backend antes de entrar", () => {
  test("enseña los tres con lo que dice cada uno de sí mismo", async () => {
    stubBackends();

    render(<BackendSwitcher variant="full" onSwitched={() => {}} />);

    expect(await screen.findByText("runtime de node")).toBeTruthy();
    expect(await screen.findByText("runtime de python")).toBeTruthy();
    expect(screen.getByRole("button", { name: /NestJS/ }).getAttribute("aria-pressed")).toBe("true");
  });

  test("uno que no está levantado se dice, en vez de ofrecerse como si nada", async () => {
    stubBackends({ down: ["go"] });

    render(<BackendSwitcher variant="full" onSwitched={() => {}} />);

    expect(await screen.findByText("no contesta")).toBeTruthy();
  });

  test("cuenta lo que el backend elegido todavía no cubre, antes de entrar y no al llegar", async () => {
    stubBackends({
      modules: {
        python: { auth: "full", runs: "none", mocks: "none", docs: "none", monitors: "none" },
        go: { auth: "full", runs: "none" },
      },
    });

    render(<BackendSwitcher variant="full" onSwitched={() => {}} />);

    expect(await screen.findByText(/sin 4 módulos: runs, mocks, docs…/)).toBeTruthy();
    expect(await screen.findByText(/sin 1 módulo: runs$/)).toBeTruthy();
  });

  test("elegir otro lo recuerda y avisa a quien tenga que recargar", async () => {
    stubBackends();
    const switched = vi.fn();
    render(<BackendSwitcher variant="full" onSwitched={switched} />);

    fireEvent.click(await screen.findByRole("button", { name: /Go/ }));

    expect(selectedBackendId()).toBe("go");
    expect(switched).toHaveBeenCalledOnce();
  });

  test("volver a pulsar el que ya está elegido no recarga nada", async () => {
    stubBackends();
    const switched = vi.fn();
    render(<BackendSwitcher variant="full" onSwitched={switched} />);

    fireEvent.click(await screen.findByRole("button", { name: /NestJS/ }));

    expect(switched).not.toHaveBeenCalled();
  });
});

describe("el selector de la cabecera", () => {
  test("dice quién contesta y en qué estado está", async () => {
    stubBackends();

    render(<BackendSwitcher onSwitched={() => {}} />);

    expect(screen.getByLabelText("sondeando")).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText("backend disponible")).toBeTruthy());
    expect((screen.getByLabelText("Backend") as HTMLSelectElement).value).toBe("node");
  });

  test("con el backend elegido caído, lo dice en vez de fingir que va", async () => {
    selectBackend("python");
    stubBackends({ down: ["python"] });

    render(<BackendSwitcher onSwitched={() => {}} />);

    await waitFor(() => expect(screen.getByLabelText("backend caído")).toBeTruthy());
  });

  test("cambiar desde la cabecera recarga la página: la caché es del backend que la llenó", async () => {
    stubBackends();
    const reload = vi.fn();
    // `window.location.reload` no está implementado en jsdom; se sustituye para poder afirmar que
    // se llama, que es la parte que importa.
    Object.defineProperty(window, "location", { value: { ...window.location, reload }, writable: true });

    render(<BackendSwitcher />);
    fireEvent.change(screen.getByLabelText("Backend"), { target: { value: "python" } });

    expect(selectedBackendId()).toBe("python");
    expect(reload).toHaveBeenCalledOnce();
  });
});
