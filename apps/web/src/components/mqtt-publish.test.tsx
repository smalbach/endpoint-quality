/**
 * Las piezas de MQTT que la pantalla de canales monta: los avisos de tema, lo que se manda al
 * publicar, el editor de propiedades de MQTT 5, la barra de suscribirse y cómo se enseña el tema y
 * las propiedades de un mensaje. Lo que ya prueba la pantalla entera (`channels-mqtt.test.tsx`) no
 * se repite; aquí van los casos que allí no salen.
 */
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  BLANK_PUBLISH,
  MessageProperties,
  MessageRoute,
  MqttPublishFields,
  MqttSubscribeBar,
  UserPropertiesEditor,
  publishBody,
  publishTopicHint,
  topicFilterHint,
  type UserProperty,
} from "@/components/mqtt-publish";
import type { ChannelMessageView } from "@/lib/types";

describe("los avisos de tema", () => {
  test("un filtro vacío, un # que no va al final y un + que no ocupa el nivel", () => {
    expect(topicFilterHint("  ")).toBe("Falta el tema");
    expect(topicFilterHint("a/#/b")).toBe("# va solo y en el último nivel: sensores/#");
    expect(topicFilterHint("a/b#")).toBe("# va solo y en el último nivel: sensores/#");
    expect(topicFilterHint("a/b+/c")).toBe("+ ocupa un nivel entero: sensores/+/temp");
    expect(topicFilterHint("a/+/c/#")).toBeNull();
  });

  test("publicar pide un tema sin comodines", () => {
    expect(publishTopicHint("")).toBe("Falta el tema");
    expect(publishTopicHint("a/+")).toBe("Para publicar, un tema sin comodines (+ ni #)");
    expect(publishTopicHint("a/b")).toBeNull();
  });

  test("lo que se publica lleva propiedades sólo en 5.0 y sólo las que tienen nombre", () => {
    const draft = {
      ...BLANK_PUBLISH,
      topic: "t",
      userProperties: [
        { name: "a", value: "1" },
        { name: " ", value: "" },
      ],
    };
    expect(publishBody(draft, 5)).toEqual({
      topic: "t",
      qos: 0,
      retain: false,
      userProperties: [{ name: "a", value: "1" }],
    });
    expect(publishBody(draft, 4)).toEqual({ topic: "t", qos: 0, retain: false });
    expect(publishBody({ ...draft, userProperties: [] }, 5)).toEqual({ topic: "t", qos: 0, retain: false });
  });
});

describe("los campos de publicar", () => {
  function Harness({ version }: { version: 4 | 5 }) {
    const [value, setValue] = useState(BLANK_PUBLISH);
    return <MqttPublishFields value={value} onChange={setValue} version={version} />;
  }

  test("en 5.0 hay propiedades: se añaden, se editan una a una y se quitan", () => {
    render(<Harness version={5} />);
    fireEvent.click(screen.getByRole("button", { name: "Añadir propiedad" }));
    fireEvent.click(screen.getByRole("button", { name: "Añadir propiedad" }));
    fireEvent.change(screen.getByLabelText("Nombre de la propiedad 2"), { target: { value: "b" } });
    fireEvent.change(screen.getByLabelText("Valor de la propiedad 2"), { target: { value: "2" } });
    expect((screen.getByLabelText("Nombre de la propiedad 1") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getAllByRole("button", { name: "Quitar" })[0]!);
    expect((screen.getByLabelText("Nombre de la propiedad 1") as HTMLInputElement).value).toBe("b");
    expect(screen.queryByLabelText("Nombre de la propiedad 2")).toBeNull();
  });

  test("en 3.1.1 no hay propiedades, y un tema con comodín se avisa", () => {
    render(<Harness version={4} />);
    expect(screen.queryByRole("button", { name: "Añadir propiedad" })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("sensores/{{sala}}/temp"), { target: { value: "a/#" } });
    expect(screen.getByText("Para publicar, un tema sin comodines (+ ni #)")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("checkbox"));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("2");
  });

  test("deshabilitado no deja añadir ni quitar propiedades", () => {
    const rows: UserProperty[] = [{ name: "a", value: "1" }];
    render(<UserPropertiesEditor label="Props" rows={rows} onChange={vi.fn()} disabled />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("la barra de suscribirse", () => {
  test("con un filtro válido suscribe con su QoS o da de baja; uno inválido no deja", () => {
    const onSubscribe = vi.fn();
    const onUnsubscribe = vi.fn();
    render(<MqttSubscribeBar onSubscribe={onSubscribe} onUnsubscribe={onUnsubscribe} />);
    fireEvent.change(screen.getByLabelText("Filtro"), { target: { value: "a/#/b" } });
    expect((screen.getByRole("button", { name: "Suscribir" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Filtro"), { target: { value: "alarmas/#" } });
    fireEvent.change(screen.getByLabelText("QoS de la suscripción"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Suscribir" }));
    expect(onSubscribe).toHaveBeenCalledWith("alarmas/#", 1);
    fireEvent.click(screen.getByRole("button", { name: "Dar de baja" }));
    expect(onUnsubscribe).toHaveBeenCalledWith("alarmas/#");
  });
});

describe("el tema y las propiedades de un mensaje", () => {
  const message = (patch: Partial<ChannelMessageView>): ChannelMessageView =>
    ({
      seq: 0,
      direction: "in",
      atMs: 0,
      kind: "text",
      body: "",
      bytes: 0,
      truncated: false,
      ...patch,
    }) as ChannelMessageView;

  test("sin tema no hay ruta; con tema, su QoS si la hay", () => {
    const { container, rerender } = render(<MessageRoute message={message({})} />);
    expect(container.textContent).toBe("");
    rerender(<MessageRoute message={message({ topic: "a/b" })} />);
    expect(container.textContent).toBe("a/b");
  });

  test("sin propiedades no se pinta nada", () => {
    const { container } = render(<MessageProperties message={message({})} />);
    expect(container.textContent).toBe("");
  });

  test("tipo, tema de respuesta y correlación en hex, sin propiedades de usuario", () => {
    render(
      <MessageProperties
        message={message({
          properties: {
            contentType: "application/json",
            responseTopic: "r/1",
            correlationData: "a1b2",
            correlationEncoding: "hex",
          },
        })}
      />,
    );
    const text = screen.getByLabelText("Propiedades").textContent;
    expect(text).toContain("tipo de contenidoapplication/json");
    expect(text).toContain("tema de respuestar/1");
    expect(text).toContain("correlación (hex)a1b2");
  });

  test("una correlación en texto se dice como texto, y sin ella no sale", () => {
    const { rerender } = render(
      <MessageProperties message={message({ properties: { userProperties: [["x", "1"]], correlationData: "abc" } })} />,
    );
    expect(screen.getByText("correlación (texto)")).toBeTruthy();
    rerender(<MessageProperties message={message({ properties: { userProperties: [["x", "1"]] } })} />);
    expect(screen.queryByText(/correlación/)).toBeNull();
    expect(screen.getByText("x")).toBeTruthy();
  });
});
