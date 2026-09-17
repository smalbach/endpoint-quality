/**
 * El editor de autenticación: los trece tipos, sus campos, y el aviso del secreto.
 *
 * Lo que se comprueba aquí no es que pinte: es que **cambiar de tipo no borra lo escrito** —quien
 * prueba `basic` y vuelve a `bearer` espera su token todavía ahí— y que un secreto literal avisa de
 * que no se guarda *antes* de darle a guardar, no después.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { AuthEditor, AUTH_FIELDS, AUTH_LABELS } from "@/components/auth-editor";
import type { RequestAuthView } from "@/lib/types";

function Harness({ initial }: { initial?: RequestAuthView }) {
  const [auth, setAuth] = useState<RequestAuthView>(initial ?? { type: "inherit", params: {} });
  return <AuthEditor auth={auth} onChange={setAuth} variables={["token", "pass"]} inheritHint="Lo del proyecto" />;
}

describe("el editor de autenticación", () => {
  test("ofrece los trece tipos de Postman", () => {
    render(<Harness />);
    const select = screen.getByLabelText("Tipo de autenticación") as HTMLSelectElement;
    expect(select.options).toHaveLength(13);
    expect([...select.options].map((option) => option.value)).toContain("awsv4");
    expect(screen.getByText("Lo del proyecto")).toBeTruthy();
  });

  test("cada tipo enseña sus campos, y solo los suyos", () => {
    render(<Harness />);
    const select = screen.getByLabelText("Tipo de autenticación");
    fireEvent.change(select, { target: { value: "awsv4" } });
    expect(screen.getByLabelText("Access key")).toBeTruthy();
    expect(screen.getByLabelText("Secret key")).toBeTruthy();
    expect(screen.queryByLabelText("Usuario")).toBeNull();

    fireEvent.change(select, { target: { value: "basic" } });
    expect(screen.getByLabelText("Usuario")).toBeTruthy();
    expect(screen.queryByLabelText("Access key")).toBeNull();
  });

  test("cambiar de tipo conserva lo escrito, como el cuerpo conserva cada modo", () => {
    render(<Harness />);
    const select = screen.getByLabelText("Tipo de autenticación");
    fireEvent.change(select, { target: { value: "bearer" } });
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "{{token}}" } });
    fireEvent.change(select, { target: { value: "basic" } });
    fireEvent.change(select, { target: { value: "bearer" } });
    expect((screen.getByLabelText("Token") as HTMLInputElement).value).toBe("{{token}}");
  });

  test("un secreto literal avisa de que no se guarda; una variable no", () => {
    render(<Harness initial={{ type: "basic", params: {} }} />);
    fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: "hunter2" } });
    expect(screen.getByText(/no se guarda/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: "{{pass}}" } });
    expect(screen.queryByText(/no se guarda/)).toBeNull();
  });

  test("un secreto va tapado hasta que se pide verlo", () => {
    render(<Harness initial={{ type: "bearer", params: { token: "eyJhbGciOi" } }} />);
    const field = screen.getByLabelText("Token") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.click(screen.getByText("Ver"));
    expect((screen.getByLabelText("Token") as HTMLInputElement).type).toBe("text");
  });

  test("NTLM dice en la propia pantalla que no se puede firmar", () => {
    render(<Harness initial={{ type: "ntlm", params: {} }} />);
    expect(screen.getByText(/tres vueltas/)).toBeTruthy();
  });

  test("todo tipo con campos tiene etiqueta, y toda etiqueta tiene tipo", () => {
    for (const [type, fields] of Object.entries(AUTH_FIELDS)) {
      expect(AUTH_LABELS[type as keyof typeof AUTH_LABELS], type).toBeTruthy();
      // Un campo sin nombre no se puede guardar ni leer: sería un formulario que no escribe nada.
      for (const field of fields) expect(field.name, `${type}.${field.label}`).toBeTruthy();
    }
    expect(Object.keys(AUTH_LABELS).sort()).toEqual(Object.keys(AUTH_FIELDS).sort());
  });

  test("deshabilitado no deja escribir", () => {
    const onChange = vi.fn();
    render(<AuthEditor auth={{ type: "basic", params: {} }} onChange={onChange} variables={[]} disabled />);
    expect((screen.getByLabelText("Usuario") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Tipo de autenticación") as HTMLSelectElement).disabled).toBe(true);
  });
});
