/**
 * Lo que se pone encima de una pantalla: el cajón y el modal se cierran con Escape, con la × y con
 * un clic fuera (el modal no, si el clic empieza dentro); el diálogo de nombre no acepta un nombre
 * vacío y entrega el recortado; la confirmación confirma o cancela, y avisa mientras está en curso;
 * la ayuda «?» lleva su texto como etiqueta y como globo.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ConfirmDialog, Drawer, HelpTooltip, Modal, PromptDialog } from "@/components/overlay";

describe("Drawer", () => {
  test("se titula, se cierra con Escape, con la × y con el clic en el fondo", () => {
    const onClose = vi.fn();
    render(
      <Drawer title="Biblioteca" onClose={onClose} footer={<span>pie</span>}>
        <p>contenido</p>
      </Drawer>,
    );
    const dialog = screen.getByRole("dialog", { name: "Biblioteca" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("pie")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    fireEvent.mouseDown(dialog.previousElementSibling!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  test("un cajón no modal a la izquierda no oscurece nada y deja pasar los clics", () => {
    render(
      <Drawer title="Nodo" side="left" modal={false} flush onClose={vi.fn()}>
        <p>x</p>
      </Drawer>,
    );
    const dialog = screen.getByRole("dialog", { name: "Nodo" });
    expect(dialog.getAttribute("aria-modal")).toBe("false");
    expect(dialog.className).toContain("left-0");
    expect(dialog.parentElement!.className).toContain("pointer-events-none");
    expect(dialog.previousElementSibling).toBeNull();
  });
});

describe("Modal", () => {
  test("describe, y un clic que empieza dentro del panel no lo cierra; uno fuera sí", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Nuevo" description="Para qué sirve" onClose={onClose} footer={<button>ok</button>} size="xl">
        <p>cuerpo</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Nuevo" });
    expect(screen.getByText("Para qué sirve")).toBeTruthy();
    expect(dialog.className).toContain("max-w-4xl");
    fireEvent.mouseDown(screen.getByText("cuerpo"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("PromptDialog", () => {
  test("no acepta un nombre en blanco y entrega el nombre sin espacios", () => {
    const onSubmit = vi.fn();
    render(
      <PromptDialog
        title="Nueva carpeta"
        label="Nombre"
        hint="Agrupa peticiones"
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(screen.getByText("Agrupa peticiones")).toBeTruthy();
    const create = screen.getByRole("button", { name: "Crear" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "  Pedidos  " } });
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    expect(onSubmit).toHaveBeenCalledWith("Pedidos");
  });

  test("parte del valor inicial, avisa mientras guarda y Cancelar cierra", () => {
    const onClose = vi.fn();
    render(
      <PromptDialog
        title="Renombrar"
        label="Nombre"
        initialValue="Viejo"
        confirmLabel="Guardar"
        pending
        onSubmit={vi.fn()}
        onClose={onClose}
      />,
    );
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Viejo");
    expect((screen.getByRole("button", { name: "…" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ConfirmDialog", () => {
  test("confirma, cancela y se cierra con Escape", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmDialog title="¿Eliminar?" message="Se pierde todo" onConfirm={onConfirm} onClose={onClose} />);
    expect(screen.getByText("Se pierde todo")).toBeTruthy();
    const remove = screen.getByRole("button", { name: "Eliminar" });
    expect(remove.className).toContain("bg-rose-600");
    fireEvent.click(remove);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test("sin peligro es el botón normal, y en curso no se puede pulsar", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog title="¿Seguir?" message="x" danger={false} pending onConfirm={onConfirm} onClose={vi.fn()} />,
    );
    const button = screen.getByRole("button", { name: "…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.className).toContain("bg-slate-900");
    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("HelpTooltip", () => {
  test("es enfocable, lleva el texto como etiqueta y como globo, arriba o a la derecha", () => {
    const { rerender } = render(<HelpTooltip content="Qué hace esto" />);
    const chip = screen.getByLabelText("Qué hace esto");
    expect(chip.tabIndex).toBe(0);
    expect(screen.getByRole("tooltip", { hidden: true }).className).toContain("bottom-full");
    rerender(<HelpTooltip content="Qué hace esto" side="right" />);
    expect(screen.getByRole("tooltip", { hidden: true }).className).toContain("left-full");
  });
});
