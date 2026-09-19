/**
 * «Autenticación»: los campos con los que un proyecto entra en su API.
 *
 * Lo que se comprueba: que cada tipo enseña sus campos y solo los suyos, que lo tecleado sale en
 * el campo que toca, y el trato de un secreto guardado —nunca en la página, vaciar la caja **no**
 * lo borra (sigue la máscara) y solo «Quitar el guardado» lo quita—.
 */
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ProjectAuthFields } from "@/components/project-auth-fields";
import { EMPTY_AUTH, MASK } from "@/lib/project-auth";
import type { ProjectAuthView } from "@/lib/types";

function mount(
  initial: Partial<ProjectAuthView>,
  options: { errors?: Record<string, string | undefined>; disabled?: boolean } = {},
) {
  const onChange = vi.fn();
  let latest: ProjectAuthView = { ...EMPTY_AUTH, ...initial };
  function Harness() {
    const [value, setValue] = useState(latest);
    return (
      <ProjectAuthFields
        value={value}
        errors={options.errors}
        disabled={options.disabled}
        onChange={(next) => {
          latest = next;
          onChange(next);
          setValue(next);
        }}
      />
    );
  }
  render(<Harness />);
  return { onChange, saved: () => latest };
}

describe("los campos de autenticación", () => {
  test("«Ninguna» no pide nada; cambiar el tipo enseña los campos del nuevo", () => {
    const form = mount({});
    expect(screen.queryByLabelText(/^Token/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Tipo"), { target: { value: "basic" } });
    expect(form.saved().type).toBe("basic");
    expect(screen.getByLabelText("Usuario")).toBeDefined();
    expect(screen.getByLabelText("Contraseña")).toBeDefined();
  });

  test("bearer: token, login, método, cuerpo y ruta del token van cada uno a su campo", () => {
    const form = mount({ type: "bearer" });
    fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: "abc" } });
    fireEvent.change(screen.getByLabelText(/^URL de login/), { target: { value: "/auth/login" } });
    fireEvent.change(screen.getByLabelText("Método"), { target: { value: "PUT" } });
    fireEvent.change(screen.getByLabelText(/^Body del login/), { target: { value: '{"a":1}' } });
    fireEvent.change(screen.getByLabelText(/^Ruta del token/), { target: { value: "data.token" } });
    expect(form.saved()).toMatchObject({
      type: "bearer",
      token: "abc",
      loginUrl: "/auth/login",
      loginMethod: "PUT",
      loginBody: '{"a":1}',
      tokenPath: "data.token",
    });
  });

  test("api key: cabecera y clave", () => {
    const form = mount({ type: "api_key" });
    fireEvent.change(screen.getByLabelText("Cabecera"), { target: { value: "X-Key" } });
    fireEvent.change(screen.getByLabelText("Clave"), { target: { value: "k" } });
    expect(form.saved()).toMatchObject({ headerName: "X-Key", apiKey: "k" });
  });

  test("basic: el usuario se escribe", () => {
    const form = mount({ type: "basic" });
    fireEvent.change(screen.getByLabelText("Usuario"), { target: { value: "qa" } });
    fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: "pw" } });
    expect(form.saved()).toMatchObject({ username: "qa", password: "pw" });
  });

  test("los errores del servidor salen en su campo, en lugar de la pista", () => {
    mount({ type: "bearer" }, { errors: { "auth.loginUrl": "No es una URL" } });
    expect(screen.getByText("No es una URL")).toBeDefined();
    expect(screen.queryByText("Absoluta o una ruta que empiece por /.")).toBeNull();
  });
});

describe("un secreto guardado", () => {
  test("no está en la página: la caja está vacía y dice que hay uno guardado", () => {
    mount({ type: "api_key", apiKey: MASK });
    const input = screen.getByLabelText<HTMLInputElement>("Clave");
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Guardado y cifrado · escribe para sustituirlo");
  });

  test("teclear lo sustituye, y a partir de ahí vaciar la caja la vacía de verdad", () => {
    const form = mount({ type: "api_key", apiKey: MASK });
    const input = screen.getByLabelText("Clave");
    fireEvent.change(input, { target: { value: "nueva" } });
    expect(form.saved().apiKey).toBe("nueva");
    // Ya no es el guardado: vaciarla ahora deja la caja vacía de verdad.
    fireEvent.change(input, { target: { value: "" } });
    expect(form.saved().apiKey).toBe("");
  });

  test("solo «Quitar el guardado» lo borra", () => {
    const form = mount({ type: "basic", password: MASK });
    fireEvent.click(screen.getByRole("button", { name: "Quitar el guardado" }));
    expect(form.saved().password).toBe("");
    expect(screen.queryByRole("button", { name: "Quitar el guardado" })).toBeNull();
  });

  test.each([
    ["Token", "token", "bearer"],
    ["Body del login", "loginBody", "bearer"],
  ] as const)("vaciar la caja de «%s» guardado no lo borra: sigue la máscara", (label, key, type) => {
    // Pinchar en el campo y salir no puede ser un borrado que nadie quiso: eso es «Quitar».
    const onChange = vi.fn();
    render(<ProjectAuthFields value={{ ...EMPTY_AUTH, type, [key]: MASK }} onChange={onChange} />);
    const box = screen.getByLabelText<HTMLInputElement>(new RegExp(`^${label}`));
    expect(box.value).toBe("");
    // El nodo tiene que creer que valía otra cosa para que React emita el cambio a vacío.
    box.value = "z";
    fireEvent.change(box, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ [key]: MASK }));
  });

  test("bloqueado no se ofrece quitarlo ni se puede escribir", () => {
    mount({ type: "api_key", apiKey: MASK }, { disabled: true });
    expect(screen.queryByRole("button", { name: "Quitar el guardado" })).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>("Clave").disabled).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>("Tipo").disabled).toBe(true);
  });
});
