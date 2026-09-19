/**
 * El vocabulario pequeño de las pantallas: la «i» abre su globo y lo cierra con otro clic, Escape,
 * un clic fuera o un desplazamiento (no con una tecla cualquiera ni con un clic dentro); el campo
 * enseña el error antes que la pista; el JSON vacío dice que no hay contenido; una aserción es
 * superada, aviso o fallo; y el vacío y la insignia enseñan lo que se les da.
 */
import { describe, expect, test } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { AssertionRow, Badge, Card, Empty, Field, InfoTip, Json } from "@/components/ui";

describe("InfoTip", () => {
  test("se abre con un clic y se cierra con otro, con Escape, con un clic fuera y al desplazar", () => {
    render(<InfoTip label="Qué es">Explicación larga</InfoTip>);
    const button = screen.getByRole("button", { name: "Qué es" });
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("tooltip").textContent).toBe("Explicación larga");
    fireEvent.click(button);
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.click(button);
    fireEvent.keyDown(document, { key: "a" });
    fireEvent.mouseDown(button);
    fireEvent.mouseDown(screen.getByRole("tooltip"));
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.click(button);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.click(button);
    fireEvent.scroll(window);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  test("cerca del borde inferior se abre por encima", () => {
    render(<InfoTip>abajo</InfoTip>);
    const button = screen.getByRole("button", { name: "Más información" });
    button.getBoundingClientRect = () =>
      ({
        left: 10,
        top: window.innerHeight - 10,
        bottom: window.innerHeight,
        right: 20,
        width: 10,
        height: 10,
      }) as DOMRect;
    fireEvent.click(button);
    expect(screen.getByRole("tooltip").style.transform).toBe("translateY(-100%)");
  });

  test("dentro de un campo, la «i» abre la explicación del campo", () => {
    render(
      <Field label="Nombre" info="Cómo se llama">
        <input aria-label="control" />
      </Field>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Qué es «Nombre»" }));
    expect(screen.getByRole("tooltip").textContent).toBe("Cómo se llama");
  });
});

describe("Field", () => {
  test("el error gana a la pista", () => {
    const { rerender } = render(
      <Field label="Ruta" hint="Empieza por /">
        <input />
      </Field>,
    );
    expect(screen.getByText("Empieza por /")).toBeTruthy();
    rerender(
      <Field label="Ruta" hint="Empieza por /" error="Falta la barra">
        <input />
      </Field>,
    );
    expect(screen.getByText("Falta la barra")).toBeTruthy();
    expect(screen.queryByText("Empieza por /")).toBeNull();
  });
});

describe("Json", () => {
  test("vacío dice que no hay contenido; un texto sale tal cual y un objeto con sangría", () => {
    const { rerender } = render(<Json value={null} />);
    expect(screen.getByText("Sin contenido")).toBeTruthy();
    rerender(<Json value="" empty="Nada" />);
    expect(screen.getByText("Nada")).toBeTruthy();
    rerender(<Json value="texto plano" />);
    expect(screen.getByText("texto plano")).toBeTruthy();
    rerender(<Json value={{ a: 1 }} />);
    expect(document.querySelector("code")!.textContent).toBe('{\n  "a": 1\n}');
  });
});

describe("AssertionRow", () => {
  test("superada, aviso y fallo tienen su marca", () => {
    const { rerender } = render(<AssertionRow label="Estado" pass detail="200" />);
    expect(screen.getByText("✓")).toBeTruthy();
    rerender(<AssertionRow label="Esquema" pass={false} detail="campo extra" severity="warning" />);
    expect(screen.getByText("!").className).toContain("bg-amber-500");
    rerender(<AssertionRow label="Esquema" pass={false} detail="falta id" />);
    expect(screen.getByText("✗").className).toContain("bg-rose-500");
    expect(screen.getByText("falta id")).toBeTruthy();
  });
});

describe("Empty, Card y Badge", () => {
  test("enseñan título, pista, acción y contenido", () => {
    render(
      <Card data-testid="card">
        <Badge className="extra">GET</Badge>
        <Empty title="Nada aún" hint="Crea uno" action={<button>Crear</button>} />
      </Card>,
    );
    expect(screen.getByTestId("card").className).toContain("rounded-2xl");
    expect(screen.getByText("GET").className).toContain("extra");
    expect(screen.getByText("Nada aún")).toBeTruthy();
    expect(screen.getByText("Crea uno")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Crear" })).toBeTruthy();
  });
});
