/**
 * Los avisos de la esquina: un error se anuncia como alerta y dura el doble, se cierran solos o con
 * la «×», no se amontonan más de cuatro, y pedirlos fuera del proveedor revienta en vez de callar.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { ToastProvider, useToast } from "@/components/toast";

function Buttons() {
  const toast = useToast();
  return (
    <>
      <button onClick={() => toast.success("Guardado")}>ok</button>
      <button onClick={() => toast.info("Para que lo sepas")}>info</button>
      <button onClick={() => toast.error("No se pudo")}>mal</button>
    </>
  );
}

const mount = () =>
  render(
    <ToastProvider>
      <Buttons />
    </ToastProvider>,
  );

afterEach(() => vi.useRealTimers());

describe("los avisos", () => {
  test("éxito e información son estado; un error es una alerta", () => {
    mount();
    fireEvent.click(screen.getByText("ok"));
    fireEvent.click(screen.getByText("info"));
    fireEvent.click(screen.getByText("mal"));
    expect(screen.getAllByRole("status").map((toast) => toast.textContent)).toEqual([
      "Guardado×",
      "Para que lo sepas×",
    ]);
    expect(screen.getByRole("alert").textContent).toBe("No se pudo×");
  });

  test("se cierran con la «×»", () => {
    mount();
    fireEvent.click(screen.getByText("info"));
    fireEvent.click(screen.getByRole("button", { name: "Cerrar aviso" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("se van solos: los normales a los cuatro segundos, los errores a los ocho", () => {
    vi.useFakeTimers();
    mount();
    fireEvent.click(screen.getByText("ok"));
    fireEvent.click(screen.getByText("mal"));
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("no hay más de cuatro a la vez: el más viejo sale", () => {
    mount();
    for (let index = 0; index < 5; index += 1) fireEvent.click(screen.getByText("ok"));
    expect(screen.getAllByRole("status")).toHaveLength(4);
  });

  test("fuera del proveedor revienta, para que un aviso perdido no pase en silencio", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Buttons />)).toThrow("useToast fuera de ToastProvider");
    vi.restoreAllMocks();
  });
});
