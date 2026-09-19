/**
 * La pantalla de «Código».
 *
 * Lo que se comprueba: que cambiar de lenguaje cambia el código y **se recuerda** —quien trabaja en
 * Go lo va a pedir muchas veces al día—, que lo que el fragmento no puede llevar sale encima y no
 * debajo de treinta líneas, y que un lenguaje guardado que ya no existe no deja la pantalla en
 * blanco.
 */
import { afterEach, describe, expect, test, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { CodeModal } from "@/components/code-modal";
import type { SnippetRequest } from "@/lib/snippets";

const request = (patch: Partial<SnippetRequest> = {}): SnippetRequest => ({
  method: "POST",
  url: "https://api.ejemplo.com/v1/pedidos",
  headers: [],
  body: { kind: "text", text: '{"a":1}', contentType: "application/json", json: true },
  auth: { type: "none", params: {} },
  ...patch,
});

const code = () => screen.getByText(/curl |import |using |package /).textContent ?? "";

/** El aviso, en la lista de arriba y no en el comentario que el propio código lleva dentro: sale en
 * los dos sitios a propósito —quien copia solo el código se lo lleva— y aquí se mira el de arriba. */
const warning = (pattern: RegExp) => screen.getAllByText(pattern).find((element) => element.tagName === "LI");

beforeEach(() => window.localStorage.clear());

describe("elegir el lenguaje", () => {
  test("empieza en cURL, que es el que todo el mundo sabe leer", () => {
    render(<CodeModal request={request()} onClose={() => {}} />);
    expect(code()).toContain("curl -X POST");
  });

  test("cambiarlo cambia el código", () => {
    render(<CodeModal request={request()} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Lenguaje"), { target: { value: "python" } });
    expect(screen.getByText(/import requests/)).toBeTruthy();
    expect(screen.queryByText(/curl -X POST/)).toBeNull();
  });

  test("y se recuerda, en vez de cobrar el mismo peaje cada vez", () => {
    const { unmount } = render(<CodeModal request={request()} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Lenguaje"), { target: { value: "go" } });
    unmount();

    render(<CodeModal request={request()} onClose={() => {}} />);
    expect(screen.getByText(/package main/)).toBeTruthy();
  });

  test("un lenguaje guardado que ya no existe se cae a cURL y no deja la pantalla en blanco", () => {
    window.localStorage.setItem("eq.snippet-language", "cobol");
    render(<CodeModal request={request()} onClose={() => {}} />);
    expect(code()).toContain("curl -X POST");
  });

  test("la pista de qué hay que instalar sale con el lenguaje que la necesita", () => {
    render(<CodeModal request={request()} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Lenguaje"), { target: { value: "python" } });
    expect(screen.getByText("pip install requests")).toBeTruthy();
  });
});

describe("lo que el fragmento no puede llevar", () => {
  test("una firma que no se puede escribir se avisa encima del código", () => {
    render(<CodeModal request={request({ auth: { type: "awsv4", params: {} } })} onClose={() => {}} />);
    expect(warning(/la firma se calcula sobre la petición/)).toBeTruthy();
  });

  test("un secreto sin sustituir se nombra: el fragmento no corre tal cual", () => {
    render(<CodeModal request={request({ headers: [{ name: "X-Key", value: "{{apiKey}}" }] })} onClose={() => {}} />);
    expect(warning(/quedan sin sustituir por ser secretas: apiKey/)).toBeTruthy();
  });

  test("sin nada que avisar no sale un hueco vacío", () => {
    render(<CodeModal request={request()} onClose={() => {}} />);
    expect(screen.queryByText(/la firma se calcula/)).toBeNull();
    expect(screen.queryByText(/quedan sin sustituir/)).toBeNull();
  });
});

describe("sin almacenamiento", () => {
  afterEach(() => vi.restoreAllMocks());

  test("una ventana privada que no deja leer ni escribir usa cURL y deja cambiar igual", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    render(<CodeModal request={request()} onClose={() => {}} />);
    expect(code()).toContain("curl -X POST");
    fireEvent.change(screen.getByLabelText("Lenguaje"), { target: { value: "go" } });
    expect(screen.getByText(/package main/)).toBeTruthy();
  });
});

describe("copiar", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("copia el código del lenguaje elegido y el botón lo dice dos segundos", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<CodeModal request={request()} onClose={() => {}} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copiar" })));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("curl -X POST"));
    expect(screen.getByRole("button", { name: "Copiado" })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole("button", { name: "Copiar" })).toBeTruthy();
  });

  test("si el portapapeles no deja, el botón no miente", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("no"))) },
    });
    render(<CodeModal request={request()} onClose={() => {}} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copiar" })));
    expect(screen.getByRole("button", { name: "Copiar" })).toBeTruthy();
  });

  test("«Cerrar» cierra", () => {
    const onClose = vi.fn();
    render(<CodeModal request={request()} onClose={onClose} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Cerrar" }).at(-1)!);
    expect(onClose).toHaveBeenCalled();
  });
});
