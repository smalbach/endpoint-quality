/**
 * Las ramas de validación de los canales que las pruebas de extremo a extremo no pisan: cada campo
 * mal escrito de MQTT, Socket.IO y gRPC, dicho con su campo, y los planes resueltos contra el entorno.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LIMITS,
  blankChannel,
  channelProblems,
  storableHeader,
  withChanges,
  type ChannelCeilings,
  type ChannelInput,
} from "@/modules/channels/domain/model";
import {
  DEFAULT_MQTT,
  brokerUrlProblems,
  mergedSettings,
  mqttSessionPlan,
  planProblems,
  protocolProblems,
  userPropertiesProblems,
  type MqttSettings,
} from "@/modules/channels/domain/mqtt";
import {
  DEFAULT_SOCKETIO,
  argsBody,
  authPayloadProblem,
  emitValues,
  eventNameProblem,
  mergedSocketIo,
  socketIoProblems,
  socketIoSessionPlan,
  socketIoUrlProblems,
  storableAuthPayload,
} from "@/modules/channels/domain/socketio";
import {
  SECRET_METADATA,
  binaryMetadataProblem,
  grpcExpectationProblems,
  grpcPort,
  grpcSettingsProblems,
  grpcUrlProblems,
  metadataKeyProblem,
  protoFilesProblems,
} from "@/modules/channels/domain/grpc";
import {
  ProtoSchemaError,
  exampleOf,
  isReadOnly,
  messageProblem,
  schemaFromDescriptors,
  schemaFromFiles,
  unknownFields,
} from "@/modules/channels/domain/grpc-schema";

const CEILINGS: ChannelCeilings = { ...DEFAULT_LIMITS, maxOpen: 20 };
const fields = (problems: { field: string }[]) => problems.map((problem) => problem.field);
const any = (value: unknown) => value as never;

describe("MQTT: lo que no se guarda", () => {
  test("un canal que no es MQTT no lleva ajustes ni temas", () => {
    const problems = protocolProblems({
      protocol: "ws",
      mqtt: { version: 4 },
      messages: [{ name: "a", body: "x", topic: "t" }],
    });
    assert.deepEqual(fields(problems), ["mqtt", "messages"]);
    // `null` es «sin ajustes», que es lo que debe tener un WebSocket.
    assert.deepEqual(protocolProblems({ protocol: "ws", mqtt: null, messages: [null as never] }), []);
  });

  test("lo que es de un upgrade HTTP no existe en MQTT", () => {
    const problems = protocolProblems({
      protocol: "mqtt",
      subprotocols: ["mqtt"],
      headers: [{ name: "x", value: "y", enabled: true }],
      auth: { type: "bearer", params: { token: "t" } },
      expectations: { closeCode: 1000 },
      mqtt: null,
    });
    assert.deepEqual(fields(problems), ["subprotocols", "headers", "auth.type", "expectations.closeCode", "mqtt"]);
    assert.deepEqual(protocolProblems({ protocol: "mqtt", auth: { type: "basic", params: {} } }), []);
  });

  test("una trama guardada de MQTT: tema publicable, QoS y retain", () => {
    const problems = protocolProblems({
      protocol: "mqtt",
      messages: [
        null as never,
        { name: "a", body: "", topic: "sensores/#", qos: any(3), retain: any("si") },
        { name: "b", body: "", topic: "{{base}}/+" },
        { name: "c", body: "", topic: "" },
      ],
    });
    assert.deepEqual(fields(problems), ["messages.1.topic", "messages.1.qos", "messages.1.retain"]);
  });

  test("cada ajuste mal escrito se dice con su campo", () => {
    const problems = protocolProblems({
      protocol: "mqtt",
      mqtt: any({
        version: 3,
        clientId: 7,
        keepaliveSec: 70_000,
        cleanSession: "si",
        subscriptions: "sensores/#",
      }),
    });
    assert.deepEqual(fields(problems), [
      "mqtt.version",
      "mqtt.clientId",
      "mqtt.keepaliveSec",
      "mqtt.cleanSession",
      "mqtt.subscriptions",
    ]);
    const long = protocolProblems({ protocol: "mqtt", mqtt: { clientId: "x".repeat(257), keepaliveSec: -1 } });
    assert.deepEqual(long, [
      { field: "mqtt.clientId", detail: "Como mucho 256 caracteres" },
      { field: "mqtt.keepaliveSec", detail: "Segundos, de 0 a 65535" },
    ]);
    assert.deepEqual(protocolProblems({ protocol: "mqtt", mqtt: any([]) }), [{ field: "mqtt", detail: "Es un objeto" }]);
    assert.deepEqual(fields(protocolProblems({ protocol: "mqtt", mqtt: { keepaliveSec: 1.5 } })), ["mqtt.keepaliveSec"]);
  });

  test("suscripciones: tope, filtro válido, sin repetir y con QoS", () => {
    const many = Array.from({ length: 51 }, (_, index) => ({ topic: `t/${index}`, qos: 0 as const }));
    assert.deepEqual(fields(protocolProblems({ protocol: "mqtt", mqtt: { subscriptions: many } })), [
      "mqtt.subscriptions",
    ]);
    const problems = protocolProblems({
      protocol: "mqtt",
      mqtt: {
        subscriptions: [
          { topic: "a/#/b", qos: 0 },
          { topic: "a/+", qos: 1 },
          { topic: "a/+", qos: 2 },
          any({ topic: "c", qos: 5 }),
          any(null),
        ],
      },
    });
    assert.deepEqual(problems, [
      { field: "mqtt.subscriptions.0.topic", detail: "# va solo y en el último nivel: sensores/#" },
      { field: "mqtt.subscriptions.2.topic", detail: "Ya hay una suscripción a ese tema" },
      { field: "mqtt.subscriptions.3.qos", detail: "QoS es 0, 1 o 2" },
      { field: "mqtt.subscriptions.4.topic", detail: problems[3].detail },
      { field: "mqtt.subscriptions.4.qos", detail: "QoS es 0, 1 o 2" },
    ]);
  });

  test("el testamento: tema sin comodines, cuerpo de texto con tope, QoS y retain", () => {
    const bad = protocolProblems({
      protocol: "mqtt",
      mqtt: { will: any({ topic: "a/+", payload: 5, qos: 9, retain: "no" }) },
    });
    assert.deepEqual(fields(bad), ["mqtt.will.topic", "mqtt.will.payload", "mqtt.will.qos", "mqtt.will.retain"]);
    const big = protocolProblems({
      protocol: "mqtt",
      mqtt: { will: { topic: "{{t}}/+", payload: "x".repeat(16 * 1024 + 1), qos: 1, retain: false } },
    });
    assert.deepEqual(big, [{ field: "mqtt.will.payload", detail: "Como mucho 16 KB" }]);
    assert.deepEqual(protocolProblems({ protocol: "mqtt", mqtt: { will: any("x") } }), [
      { field: "mqtt.will", detail: "Es un objeto" },
    ]);
    assert.deepEqual(protocolProblems({ protocol: "mqtt", mqtt: { will: null } }), []);
  });

  test("propiedades de usuario: solo en 5.0, con nombre y valor de texto y tope", () => {
    const v4 = protocolProblems({ protocol: "mqtt", mqtt: { version: 4, userProperties: [{ name: "a", value: "b" }] } });
    assert.deepEqual(fields(v4), ["mqtt.userProperties"]);
    assert.deepEqual(protocolProblems({ protocol: "mqtt", mqtt: { version: 4, userProperties: [] } }), []);
    assert.deepEqual(userPropertiesProblems("x", "p"), [{ field: "p", detail: "Las propiedades son una lista" }]);
    assert.deepEqual(userPropertiesProblems(new Array(21).fill({ name: "a", value: "b" }), "p"), [
      { field: "p", detail: "Como mucho 20" },
    ]);
    const long = "x".repeat(1025);
    assert.deepEqual(userPropertiesProblems([{ name: " ", value: 1 }, { name: long, value: long }, null], "p"), [
      { field: "p.0.name", detail: "Falta el nombre" },
      { field: "p.0.value", detail: "Es texto" },
      { field: "p.1.name", detail: "Como mucho 1024 caracteres" },
      { field: "p.1.value", detail: "Como mucho 1024 caracteres" },
      { field: "p.2.name", detail: "Falta el nombre" },
      { field: "p.2.value", detail: "Es texto" },
    ]);
  });

  test("la URL de un broker", () => {
    assert.deepEqual(brokerUrlProblems(""), [{ field: "url", detail: "Falta la URL del broker" }]);
    assert.deepEqual(brokerUrlProblems(42), [{ field: "url", detail: "Falta la URL del broker" }]);
    assert.deepEqual(brokerUrlProblems(`mqtt://${"a".repeat(2001)}`), [
      { field: "url", detail: "Como mucho 2000 caracteres" },
    ]);
    assert.deepEqual(brokerUrlProblems("mqtt://a b"), [{ field: "url", detail: "Una URL no lleva espacios" }]);
    assert.deepEqual(brokerUrlProblems("{{broker}}"), []);
    assert.deepEqual(brokerUrlProblems("broker:1883"), [
      { field: "url", detail: "Un broker MQTT empieza por mqtt://, mqtts://, ws:// o wss://, no por broker://" },
    ]);
    assert.deepEqual(brokerUrlProblems("no es url"), [{ field: "url", detail: "Una URL no lleva espacios" }]);
    assert.deepEqual(brokerUrlProblems("nourl"), [
      { field: "url", detail: "No es una URL: empieza por mqtt:// o mqtts://" },
    ]);
    assert.deepEqual(brokerUrlProblems("mqtts://u:p@broker"), [
      { field: "url", detail: "Usuario y contraseña van en la autenticación, no en la URL" },
    ]);
    for (const url of ["mqtt://b", "mqtts://b:8883", "ws://b/mqtt", "wss://b/mqtt"]) assert.deepEqual(brokerUrlProblems(url), []);
  });

  test("al guardar: se recorta el id, se copian las suscripciones y las propiedades solo en 5.0", () => {
    const current: MqttSettings = {
      ...DEFAULT_MQTT,
      version: 5,
      userProperties: [{ name: "authorization", value: "Bearer abc" }],
    };
    const merged = mergedSettings(current, {
      clientId: "  sensor-1 ",
      subscriptions: [{ topic: "a", qos: 1, extra: true } as never],
      will: { topic: "w", payload: "adios", qos: 0, retain: true },
    });
    assert.equal(merged.clientId, "sensor-1");
    assert.deepEqual(merged.subscriptions, [{ topic: "a", qos: 1 }]);
    assert.deepEqual(merged.will, { topic: "w", payload: "adios", qos: 0, retain: true });
    // Una propiedad con nombre de credencial escrita a mano se guarda vacía.
    assert.deepEqual(merged.userProperties, [{ name: "authorization", value: "" }]);
    const v4 = mergedSettings(null, { version: 4, userProperties: [{ name: "a", value: "b" }] });
    assert.deepEqual(v4.userProperties, []);
    assert.equal(v4.will, null);
    const v5 = mergedSettings({ ...DEFAULT_MQTT, version: 5, userProperties: undefined as never }, {});
    assert.deepEqual(v5.userProperties, []);
  });

  test("el plan: credenciales, propiedades con nombre de secreto y un id inventado", () => {
    const secrets: string[] = [];
    const interpolate = (value: string) => value.replace("{{pw}}", "s3cret").replace("{{sala}}", "cocina");
    const plan = mqttSessionPlan(
      {
        ...DEFAULT_MQTT,
        version: 5,
        subscriptions: [{ topic: "casa/{{sala}}/#", qos: 1 }],
        will: { topic: "estado/{{sala}}", payload: "caido {{sala}}", qos: 1, retain: true },
        userProperties: [
          { name: "x-api-key", value: "k-{{pw}}" },
          { name: "cliente", value: "{{sala}}" },
          { name: "token", value: "" },
        ],
      },
      { type: "basic", params: { username: "yo", password: "{{pw}}" } },
      interpolate,
      secrets,
      () => "abc",
    );
    assert.equal(plan.clientId, "eq-abc");
    assert.equal(plan.username, "yo");
    assert.equal(plan.password, "s3cret");
    assert.deepEqual(plan.subscriptions, [{ topic: "casa/cocina/#", qos: 1 }]);
    assert.deepEqual(plan.will, { topic: "estado/cocina", payload: "caido cocina", qos: 1, retain: true });
    assert.equal(plan.userProperties?.length, 3);
    assert.deepEqual(secrets, ["s3cret", "k-s3cret"]);

    // Sin auth basic ni propiedades (3.1.1): nada de credenciales y el id escrito se respeta.
    const bare = mqttSessionPlan(
      { ...DEFAULT_MQTT, clientId: "fijo", userProperties: [{ name: "a", value: "b" }] },
      { type: "basic", params: {} },
      (value) => value,
      [],
      () => "nunca",
    );
    assert.deepEqual(bare, {
      version: 4,
      clientId: "fijo",
      keepaliveSec: 60,
      cleanSession: true,
      subscriptions: [],
    });
    const v5none = mqttSessionPlan(
      { ...DEFAULT_MQTT, version: 5, userProperties: undefined as never },
      null,
      (value) => value,
      [],
      () => "r",
    );
    assert.equal(v5none.userProperties, undefined);
  });

  test("un plan ya resuelto que deja de ser válido por la variable", () => {
    assert.deepEqual(
      planProblems({
        ...DEFAULT_MQTT,
        subscriptions: [
          { topic: "ok/+", qos: 0 },
          { topic: "mal#", qos: 0 },
        ],
        will: { topic: "a/+", payload: "", qos: 0, retain: false },
      }),
      [
        { field: "mqtt.subscriptions.1.topic", detail: "# va solo y en el último nivel: sensores/#" },
        { field: "mqtt.will.topic", detail: "Un tema para publicar no lleva comodines (+ ni #)" },
      ],
    );
    assert.deepEqual(
      planProblems({ version: 4, clientId: "x", keepaliveSec: 60, cleanSession: true, subscriptions: [] }),
      [],
    );
  });
});

describe("Socket.IO: lo que no se guarda", () => {
  test("un canal que no es Socket.IO no lleva ajustes ni eventos", () => {
    assert.deepEqual(
      fields(socketIoProblems({ protocol: "ws", socketio: {}, messages: [{ name: "a", body: "", event: "x" }] })),
      ["socketio", "messages"],
    );
    assert.deepEqual(socketIoProblems({ protocol: "ws", socketio: null, messages: any("x") }), []);
  });

  test("subprotocolos, código de cierre, ajustes nulos y tramas con evento reservado", () => {
    const problems = socketIoProblems({
      protocol: "socketio",
      subprotocols: ["a"],
      expectations: { closeCode: 1000 },
      socketio: null,
      messages: [null as never, { name: "a", body: "" }, { name: "b", body: "", event: "connect" }, { name: "c", body: "", event: "ok" }],
    });
    assert.deepEqual(fields(problems), ["subprotocols", "expectations.closeCode", "socketio", "messages.2.event"]);
  });

  test("nombres de evento", () => {
    assert.equal(eventNameProblem(" "), "El evento necesita un nombre");
    assert.equal(eventNameProblem(3), "El evento necesita un nombre");
    assert.equal(eventNameProblem("x".repeat(201)), "Como mucho 200 caracteres");
    assert.equal(eventNameProblem("disconnect"), "«disconnect» lo emite Socket.IO: no es un evento del servidor");
    assert.equal(eventNameProblem("chat"), null);
  });

  test("cada ajuste mal escrito se dice con su campo", () => {
    const at = (socketio: unknown) => socketIoProblems({ protocol: "socketio", socketio: any(socketio) });
    assert.deepEqual(at([]), [{ field: "socketio", detail: "Es un objeto" }]);
    assert.deepEqual(fields(at({ version: 2, path: "sin-barra", namespace: 5 })), [
      "socketio.version",
      "socketio.path",
      "socketio.namespace",
    ]);
    assert.deepEqual(at({ path: `/${"a".repeat(200)}`, namespace: "/a b" }), [
      { field: "socketio.path", detail: "Como mucho 200 caracteres" },
      { field: "socketio.namespace", detail: "Sin espacios, ? ni #" },
    ]);
    assert.deepEqual(at({ auth: 5 }), [{ field: "socketio.auth", detail: "Es texto: un objeto JSON" }]);
    assert.deepEqual(at({ auth: `{"a":"${"x".repeat(16 * 1024)}"}` }), [
      { field: "socketio.auth", detail: "Como mucho 16 KB" },
    ]);
    assert.deepEqual(fields(at({ auth: "[1]" })), ["socketio.auth"]);
    assert.deepEqual(at({ query: "a=b" }), [{ field: "socketio.query", detail: "Los parámetros son una lista" }]);
    const query = at({ query: [...new Array(50).fill({ name: "a", value: "b" }), { name: " ", value: 1 }] });
    assert.deepEqual(query, [
      { field: "socketio.query", detail: "Como mucho 50" },
      { field: "socketio.query.50.name", detail: "Falta el nombre" },
      { field: "socketio.query.50.value", detail: "Es texto" },
    ]);
    assert.deepEqual(at({ listenAll: "si" }), [{ field: "socketio.listenAll", detail: "Sí o no" }]);
    assert.deepEqual(at({ events: "chat" }), [{ field: "socketio.events", detail: "Los eventos son una lista" }]);
    const events = at({ events: [...Array.from({ length: 50 }, (_, index) => `e${index}`), "e0", "connect"] });
    assert.deepEqual(fields(events), ["socketio.events", "socketio.events.50", "socketio.events.51"]);
    assert.equal(events[1].detail, "Ya está en la lista");
    assert.deepEqual(at({ listenAll: false, events: [] }), [
      { field: "socketio.events", detail: "Sin «todos los eventos», di cuáles se oyen" },
    ]);
    for (const transports of [[], "websocket", ["smoke"], ["polling", "polling"]])
      assert.deepEqual(fields(at({ transports })), ["socketio.transports"], JSON.stringify(transports));
    assert.deepEqual(at({ transports: ["polling", "websocket"], listenAll: true, events: [] }), []);
  });

  test("la carga de auth", () => {
    assert.equal(authPayloadProblem("  "), null);
    assert.equal(authPayloadProblem('{"n": {{numero}}}'), null);
    assert.match(authPayloadProblem("{roto") ?? "", /^No es JSON/);
    assert.match(authPayloadProblem('"texto"') ?? "", /es un objeto JSON/);
    assert.equal(authPayloadProblem('{"token":"{{t}}"}'), null);
  });

  test("la URL de un servidor Socket.IO", () => {
    assert.deepEqual(socketIoUrlProblems("{{base}}"), []);
    assert.deepEqual(fields(socketIoUrlProblems("nada")), ["url"]);
    assert.match(socketIoUrlProblems("ftp://x")[0].detail, /no por ftp:\/\//);
    assert.match(socketIoUrlProblems("https://u:p@x")[0].detail, /credenciales/);
    assert.deepEqual(socketIoUrlProblems("https://x/chat"), []);
    // Por `channelProblems`, con la misma función.
    assert.deepEqual(fields(channelProblems({ url: "ftp://x" }, CEILINGS, "socketio")), ["url"]);
  });

  test("al guardar: la query sin literales de credencial y la carga sin secretos", () => {
    const merged = mergedSocketIo(null, {
      query: [
        { name: " token ", value: "abc", enabled: true },
        { name: "sala", value: "1", enabled: undefined as never },
        { name: "x-api-key", value: "{{key}}", enabled: false },
      ],
      auth: '{"token":"abc","user":{"password":"p","name":"n"},"list":[{"secret":"s"}],"jwt":"Bearer {{jwt}}"}',
    });
    assert.deepEqual(merged.query, [
      { name: "token", value: "", enabled: true },
      { name: "sala", value: "1", enabled: true },
      { name: "x-api-key", value: "{{key}}", enabled: false },
    ]);
    assert.deepEqual(JSON.parse(merged.auth), {
      token: "",
      user: { password: "", name: "n" },
      list: [{ secret: "" }],
      jwt: "Bearer {{jwt}}",
    });
  });

  test("la carga de auth guardada: tal cual si no hay nada que tapar, con sangría si la traía", () => {
    assert.equal(storableAuthPayload(""), "");
    const clean = '{ "user": "yo" }';
    assert.equal(storableAuthPayload(clean), clean);
    assert.equal(storableAuthPayload('{\n  "token": "abc"\n}'), '{\n  "token": ""\n}');
    // Una carga que no es JSON (una variable fuera de una cadena): se vacían los campos por expresión.
    assert.equal(
      storableAuthPayload('{"token": "abc", "n": {{n}}, "password": "{{pw}}", "otro": "x"}'),
      '{"token": "", "n": {{n}}, "password": "{{pw}}", "otro": "x"}',
    );
  });

  test("el plan: la carga resuelta, sus valores en los secretos y el espacio de nombres de la URL", () => {
    const secrets: string[] = [];
    const { plan, problems } = socketIoSessionPlan(
      {
        ...DEFAULT_SOCKETIO,
        auth: '{"sid":"{{sid}}","n":7,"deep":["a",{"b":""}],"flag":true}',
        query: [
          { name: "token", value: "{{sid}}", enabled: true },
          { name: "sala", value: "1", enabled: true },
          { name: "off", value: "x", enabled: false },
          { name: " ", value: "x", enabled: true },
        ],
        listenAll: false,
        events: ["{{ev}}"],
        transports: [],
        path: "",
      },
      "https://servidor/chat",
      (value) => value.replace("{{sid}}", "S1").replace("{{ev}}", "mensaje"),
      secrets,
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(plan, {
      path: "/socket.io",
      namespace: "/chat",
      auth: { sid: "S1", n: 7, deep: ["a", { b: "" }], flag: true },
      query: { token: "S1", sala: "1" },
      listenAll: false,
      events: ["mensaje"],
      transports: ["websocket"],
    });
    assert.deepEqual(secrets, ["S1", "7", "a", "S1"]);
  });

  test("el plan con una carga que ya resuelta no es un objeto, o no es JSON", () => {
    const array = socketIoSessionPlan({ ...DEFAULT_SOCKETIO, auth: "[1]" }, "https://s", (v) => v, []);
    assert.deepEqual(array.problems, [
      { field: "socketio.auth", detail: "La carga de auth, ya resuelta, no es un objeto JSON" },
    ]);
    assert.equal(array.plan.auth, null);
    const broken = socketIoSessionPlan({ ...DEFAULT_SOCKETIO, auth: "{{x}}" }, "no-url", (v) => v, []);
    assert.deepEqual(fields(broken.problems), ["socketio.auth"]);
    // Una URL que no se parsea deja el espacio de nombres en `/`.
    assert.equal(broken.plan.namespace, "/");
    const named = socketIoSessionPlan({ ...DEFAULT_SOCKETIO, namespace: "/admin" }, "https://s/chat", (v) => v, []);
    assert.equal(named.plan.namespace, "/admin");
    assert.deepEqual(named.plan.events, []);
  });

  test("los argumentos de un emit y el cuerpo de un evento", () => {
    assert.deepEqual(emitValues(["hola", ' {"a":1}', "[1,2]", "{roto", "42"]), ["hola", { a: 1 }, [1, 2], "{roto", "42"]);
    assert.equal(argsBody([]), "");
    assert.equal(argsBody(["tal cual"]), "tal cual");
    assert.equal(argsBody([{ id: 1 }]), '{"id":1}');
    assert.equal(argsBody(["a", 2]), '["a",2]');
    assert.equal(argsBody([Buffer.from([1, 2, 255])]), '{"$binary":"0102ff","bytes":3}');
    const buffer = new Uint8Array([9, 10]).buffer;
    assert.equal(argsBody([{ raw: buffer }]), '{"raw":{"$binary":"090a","bytes":2}}');
    assert.equal(argsBody([undefined]), "");
  });
});

describe("gRPC: lo que no se guarda", () => {
  test("claves de metadata y valores binarios", () => {
    assert.match(metadataKeyProblem("con espacio") ?? "", /letras, dígitos/);
    assert.match(metadataKeyProblem("grpc-timeout") ?? "", /la pone el protocolo/);
    assert.match(metadataKeyProblem("TE") ?? "", /la pone el protocolo/);
    assert.equal(metadataKeyProblem("x-trace"), null);
    assert.equal(binaryMetadataProblem("{{bin}}"), null);
    assert.equal(binaryMetadataProblem("AQID"), null);
    assert.equal(binaryMetadataProblem("AQ-_"), null);
    assert.equal(binaryMetadataProblem("no es base64!"), "Una clave -bin lleva bytes: escribe el valor en base64");
    assert.ok(SECRET_METADATA.test("x-api-key-bin"));
    assert.ok(!SECRET_METADATA.test("x-trace-bin"));
  });

  test("la URL de un canal gRPC", () => {
    assert.deepEqual(grpcUrlProblems("{{grpc}}"), []);
    assert.match(grpcUrlProblems("nada")[0].detail, /No es una URL/);
    assert.match(grpcUrlProblems("https://x")[0].detail, /no por https:\/\//);
    assert.match(grpcUrlProblems("grpc://u:p@x")[0].detail, /credenciales/);
    assert.match(grpcUrlProblems("grpc://")[0].detail, /Falta el servidor/);
    for (const url of ["grpc://x/ruta", "grpc://x?a=1", "grpc://x#h"])
      assert.match(grpcUrlProblems(url)[0].detail, /Solo servidor y puerto/, url);
    assert.deepEqual(grpcUrlProblems("grpcs://x:8443"), []);
    assert.equal(grpcPort(new URL("grpcs://x")), 443);
    assert.equal(grpcPort(new URL("grpc://x")), 80);
    assert.equal(grpcPort(new URL("grpc://x:9000")), 9000);
  });

  test("los ajustes de gRPC", () => {
    assert.deepEqual(grpcSettingsProblems(null), [{ field: "grpc", detail: "Es un objeto" }]);
    assert.deepEqual(grpcSettingsProblems("x"), [{ field: "grpc", detail: "Es un objeto" }]);
    const problems = grpcSettingsProblems({
      source: "ftp",
      service: "tienda/v1",
      method: 5,
      message: 3,
      deadlineMs: 0,
    });
    assert.deepEqual(fields(problems), ["grpc.source", "grpc.service", "grpc.method", "grpc.message", "grpc.deadlineMs"]);
    assert.deepEqual(grpcSettingsProblems({ message: "x".repeat(64 * 1024 + 1), service: "a".repeat(301) }), [
      { field: "grpc.service", detail: "Un nombre de protobuf: letras, dígitos, _ y ." },
      { field: "grpc.message", detail: "Como mucho 64 KB" },
    ]);
    assert.deepEqual(fields(grpcSettingsProblems({ deadlineMs: 600_001 })), ["grpc.deadlineMs"]);
    assert.deepEqual(fields(grpcSettingsProblems({ deadlineMs: 1.5 })), ["grpc.deadlineMs"]);
    assert.deepEqual(grpcSettingsProblems({ deadlineMs: null, source: "reflection", service: "a.B", method: "" }), []);
  });

  test("lo que afirma un canal gRPC", () => {
    assert.deepEqual(fields(grpcExpectationProblems({ closeCode: 1000, status: 17 })), [
      "expectations.closeCode",
      "expectations.status",
    ]);
    assert.deepEqual(fields(grpcExpectationProblems({ status: -1 })), ["expectations.status"]);
    assert.deepEqual(fields(grpcExpectationProblems({ status: 1.5 })), ["expectations.status"]);
    assert.deepEqual(grpcExpectationProblems({ status: 16 }), []);
  });

  test("los ficheros de un conjunto de .proto", () => {
    assert.deepEqual(protoFilesProblems("x"), [{ field: "files", detail: "Los ficheros son una lista" }]);
    const bad = protoFilesProblems([
      { path: "", content: "" },
      { path: "a.txt", content: "" },
      { path: "/abs.proto", content: "" },
      { path: "a/../b.proto", content: "" },
      { path: "a//b.proto", content: "" },
      { path: "./b.proto", content: "" },
      { path: "a b.proto", content: "" },
      { path: `${"a".repeat(300)}.proto`, content: "" },
      { path: "ok.proto", content: "" },
      { path: "ok.proto", content: 5 },
      null,
    ]);
    assert.deepEqual(fields(bad), [
      "files.0.path",
      "files.1.path",
      "files.2.path",
      "files.3.path",
      "files.4.path",
      "files.5.path",
      "files.6.path",
      "files.7.path",
      "files.9.path",
      "files.9.content",
      "files.10.path",
      "files.10.content",
    ]);
    assert.equal(bad[8].detail, "ok.proto está dos veces");
    const big = "x".repeat(256 * 1024 + 1);
    const heavy = protoFilesProblems(Array.from({ length: 101 }, (_, index) => ({ path: `f${index}.proto`, content: index < 5 ? big : "" })));
    assert.deepEqual(heavy.map((problem) => problem.detail).filter((detail) => !detail.includes("por fichero")), [
      "Como mucho 100 ficheros",
      "Como mucho 1 MB entre todos",
    ]);
    assert.equal(heavy.filter((problem) => problem.detail.includes("por fichero")).length, 5);
  });
});

describe("gRPC: el esquema", () => {
  const ARBOL = `
    syntax = "proto3";
    package arbol.v1;
    import "google/protobuf/any.proto";
    enum Color { ROJO = 0; VERDE = 1; }
    message Nodo {
      string nombre = 1;
      repeated Nodo hijos = 2;
      map<string, int32> pesos = 3;
      map<int32, string> nombres = 4;
      oneof valor { string texto = 5; int64 numero = 6; }
      optional bool marcado = 7;
      Color color = 8;
      bytes datos = 9;
      uint64 grande = 10;
      double real = 11;
      google.protobuf.Any extra = 12;
      Hoja hoja = 13;
      repeated Hoja hojas = 14;
    }
    message Hoja { string id = 1; }
    service Bosque {
      rpc Plantar (Nodo) returns (Nodo) { option idempotency_level = NO_SIDE_EFFECTS; }
      rpc Talar (stream Nodo) returns (stream Hoja);
    }
  `;

  test("el ejemplo: un oneof solo con el primero, un tipo recursivo omitido y los mapas con su clave", () => {
    const schema = schemaFromFiles([{ path: "arbol.proto", content: ARBOL }]);
    const [service] = schema.services();
    assert.equal(service.name, "arbol.v1.Bosque");
    const plantar = service.methods.find((method) => method.name === "Plantar")!;
    assert.equal(plantar.readOnly, true);
    const talar = service.methods.find((method) => method.name === "Talar")!;
    assert.deepEqual([talar.clientStreaming, talar.serverStreaming, talar.readOnly], [true, true, false]);
    const example = JSON.parse(plantar.example);
    assert.deepEqual(example.pesos, { clave: 0 });
    assert.deepEqual(example.nombres, { "0": "" });
    assert.equal(example.texto, "");
    assert.equal("numero" in example, false);
    assert.equal("hijos" in example, false);
    assert.equal(example.marcado, false);
    assert.equal(example.color, "ROJO");
    assert.equal(example.datos, "");
    assert.equal(example.grande, "0");
    assert.equal(example.real, 0);
    assert.deepEqual(example.hojas, [{ id: "" }]);
    assert.deepEqual(exampleOf(schema.root.lookupType("arbol.v1.Hoja")), { id: "" });
  });

  test("los campos que sobran, a cualquier profundidad, salvo en mapas y Any", () => {
    const schema = schemaFromFiles([{ path: "arbol.proto", content: ARBOL }]);
    const nodo = schema.root.lookupType("arbol.v1.Nodo");
    assert.deepEqual(unknownFields(nodo, [1]), []);
    assert.deepEqual(
      unknownFields(nodo, {
        nombre: "a",
        itemId: 1,
        hoja: { id: "x", sobra: 1 },
        hojas: [{ id: "a" }, { mal: 2 }],
        hijos: { nombre: "no es lista", otro: 1 },
        pesos: { cualquiera: 1 },
        extra: { "@type": "x", loquesea: 1 },
      }),
      ["itemId", "hoja.sobra", "hojas[1].mal", "hijos.otro"],
    );
    assert.equal(messageProblem(nodo, "x"), "El mensaje de arbol.v1.Nodo es un objeto JSON");
    assert.equal(messageProblem(nodo, { a: 1, b: 2 }), "arbol.v1.Nodo no tiene los campos a, b");
    assert.equal(messageProblem(nodo, { a: 1 }), "arbol.v1.Nodo no tiene el campo a");
    assert.match(messageProblem(nodo, { color: "AZUL", hoja: 5 }) ?? "", /^El mensaje no encaja con arbol\.v1\.Nodo: /);
    assert.equal(messageProblem(nodo, { nombre: "a", grande: "12" }), null);
  });

  test("un método que no está, o un servicio que no está", () => {
    const schema = schemaFromFiles([{ path: "arbol.proto", content: ARBOL }]);
    assert.equal(schema.method("arbol.v1.NoEsta", "Plantar"), null);
    assert.equal(schema.method("arbol.v1.Bosque", "NoEsta"), null);
    assert.equal(schema.method("arbol.v1.Nodo", "Plantar"), null);
    const found = schema.method("arbol.v1.Bosque", "Plantar");
    assert.equal(found?.service, "arbol.v1.Bosque");
    assert.equal(found?.definition.path, "/arbol.v1.Bosque/Plantar");
    // Una segunda llamada reutiliza las definiciones.
    assert.equal(schema.method("arbol.v1.Bosque", "Talar")?.definition.requestStream, true);
  });

  test("imports: por el final de la ruta, ambiguos, que faltan y los bien conocidos", () => {
    const ok = schemaFromFiles([
      { path: "protos/comun/dinero.proto", content: 'syntax = "proto3"; package c; message Dinero { int64 c = 1; }' },
      {
        path: "protos/tienda.proto",
        content:
          'syntax = "proto3"; package t; import "comun/dinero.proto"; import weak "google/protobuf/descriptor.proto"; message P { c.Dinero d = 1; } service S { rpc M (P) returns (P); }',
      },
    ]);
    assert.equal(ok.services()[0].name, "t.S");
    assert.throws(
      () =>
        schemaFromFiles([
          { path: "a/x.proto", content: 'syntax = "proto3";' },
          { path: "b/x.proto", content: 'syntax = "proto3";' },
          { path: "main.proto", content: 'syntax = "proto3"; import "x.proto";' },
        ]),
      (error: unknown) =>
        error instanceof ProtoSchemaError && /main\.proto: el import «x\.proto» casa con más de un fichero/.test(error.message),
    );
    assert.throws(
      () => schemaFromFiles([{ path: "main.proto", content: 'syntax = "proto3"; import "falta.proto";' }]),
      (error: unknown) =>
        error instanceof ProtoSchemaError &&
        error.field === "files" &&
        error.message === "main.proto importa «falta.proto», que no está entre los ficheros subidos",
    );
    assert.throws(
      () => schemaFromFiles([{ path: "roto.proto", content: "message {" }]),
      (error: unknown) => error instanceof ProtoSchemaError && /roto\.proto/.test(error.message),
    );
    assert.throws(
      () => schemaFromFiles([{ path: "a.proto", content: 'syntax = "proto3"; message A { NoExiste x = 1; }' }]),
      (error: unknown) => error instanceof ProtoSchemaError && /NoExiste/.test(error.message),
    );
  });

  test("descriptores de la reflexión que no se pueden leer", () => {
    assert.throws(
      () => schemaFromDescriptors([new Uint8Array([0xff, 0xff, 0xff])]),
      (error: unknown) => error instanceof ProtoSchemaError && /La reflexión devolvió descriptores/.test(error.message),
    );
  });

  test("solo lectura por el nombre del nivel o por su número", () => {
    assert.equal(isReadOnly({ options: { idempotency_level: 1 } } as never), true);
    assert.equal(isReadOnly({ options: { idempotencyLevel: "NO_SIDE_EFFECTS" } } as never), true);
    assert.equal(isReadOnly({ options: { idempotency_level: "IDEMPOTENT" } } as never), false);
    assert.equal(isReadOnly({} as never), false);
  });
});

describe("el canal: lo que no se guarda y lo que se guarda", () => {
  test("protocolo, nombre y URL", () => {
    assert.deepEqual(fields(channelProblems({}, CEILINGS, "smtp" as never)), ["protocol"]);
    assert.deepEqual(channelProblems({ name: "  " }, CEILINGS), [{ field: "name", detail: "El canal necesita un nombre" }]);
    assert.deepEqual(channelProblems({ name: any(5) }, CEILINGS), [{ field: "name", detail: "El canal necesita un nombre" }]);
    assert.deepEqual(channelProblems({ name: "x".repeat(121) }, CEILINGS), [
      { field: "name", detail: "Como mucho 120 caracteres" },
    ]);
    assert.deepEqual(channelProblems({ url: "" }, CEILINGS), [{ field: "url", detail: "Falta la URL" }]);
    assert.deepEqual(channelProblems({ url: `ws://${"a".repeat(2000)}` }, CEILINGS), [
      { field: "url", detail: "Como mucho 2000 caracteres" },
    ]);
    assert.deepEqual(channelProblems({ url: "ws://a b" }, CEILINGS), [{ field: "url", detail: "Una URL no lleva espacios" }]);
    assert.deepEqual(channelProblems({ url: "nada" }, CEILINGS), [
      { field: "url", detail: "No es una URL: empieza por ws:// o wss://" },
    ]);
    assert.deepEqual(fields(channelProblems({ url: "http://x" }, CEILINGS, "grpc")), ["url"]);
    assert.deepEqual(fields(channelProblems({ url: "http://x" }, CEILINGS, "mqtt")), ["url"]);
  });

  test("lo de gRPC en un canal gRPC y en uno que no lo es", () => {
    assert.deepEqual(fields(channelProblems({ subprotocols: ["a"] }, CEILINGS, "grpc")), ["subprotocols"]);
    assert.deepEqual(fields(channelProblems({ grpc: { deadlineMs: 0 } }, CEILINGS, "grpc")), ["grpc.deadlineMs"]);
    assert.deepEqual(channelProblems({ grpc: {} }, CEILINGS, "ws"), [
      { field: "grpc", detail: "Los ajustes de gRPC son de un canal gRPC" },
    ]);
  });

  test("subprotocolos: lista, tope y tokens", () => {
    assert.deepEqual(fields(channelProblems({ subprotocols: any("chat") }, CEILINGS)), ["subprotocols"]);
    const many = Array.from({ length: 11 }, (_, index) => `p${index}`);
    assert.deepEqual(fields(channelProblems({ subprotocols: many }, CEILINGS)), ["subprotocols"]);
    assert.deepEqual(fields(channelProblems({ subprotocols: any([5, "con espacio"]) }, CEILINGS)), [
      "subprotocols.0",
      "subprotocols.1",
    ]);
  });

  test("cabeceras y metadata", () => {
    assert.deepEqual(fields(channelProblems({ headers: any("x") }, CEILINGS)), ["headers"]);
    const many = Array.from({ length: 51 }, () => ({ name: "x-a", value: "b", enabled: true }));
    assert.deepEqual(fields(channelProblems({ headers: many }, CEILINGS)), ["headers"]);
    const problems = channelProblems(
      {
        headers: [
          any(null),
          { name: "grpc-timeout", value: "1", enabled: true },
          { name: "trace-bin", value: "no base64!", enabled: true },
          { name: "trace-bin", value: "AQID", enabled: true },
          { name: "host", value: "ok\n", enabled: true },
        ],
      },
      CEILINGS,
      "grpc",
    );
    assert.deepEqual(fields(problems), [
      "headers.0.name",
      "headers.0.value",
      "headers.1.name",
      "headers.2.value",
      "headers.4.name",
      "headers.4.value",
    ]);
    // En gRPC `host` no es una cabecera de WebSocket, pero sí metadata reservada.
    assert.match(problems[4].detail, /la pone el protocolo/);
  });

  test("topes: enteros positivos y bajo el techo", () => {
    const problems = channelProblems({ limits: { maxMessages: 0, maxBytes: 1.5, idleMs: 999_999 } }, CEILINGS);
    assert.deepEqual(problems, [
      { field: "limits.maxMessages", detail: "Un número entero mayor que cero" },
      { field: "limits.maxBytes", detail: "Un número entero mayor que cero" },
      { field: "limits.idleMs", detail: "Como mucho 10000 ms sin mensajes" },
    ]);
  });

  test("afirmaciones: objeto, contadores, estado, cierre, presupuesto y comprobaciones", () => {
    assert.deepEqual(channelProblems({ expectations: any(null) }, CEILINGS), [
      { field: "expectations", detail: "Es un objeto" },
    ]);
    assert.deepEqual(
      fields(
        channelProblems(
          { expectations: { minMessages: -1, status: 0, closeCode: 999, firstMessageBudgetMs: 0 } },
          CEILINGS,
        ),
      ),
      ["expectations.minMessages", "expectations.status", "expectations.closeCode", "expectations.firstMessageBudgetMs"],
    );
    // En gRPC el estado sí vale, y el cierre lo dice `grpcExpectationProblems`.
    assert.deepEqual(fields(channelProblems({ expectations: { status: 0, closeCode: 1000 } }, CEILINGS, "grpc")), [
      "expectations.closeCode",
    ]);
    assert.deepEqual(fields(channelProblems({ expectations: { checks: any("x") } }, CEILINGS)), ["expectations.checks"]);
    const tooMany = Array.from({ length: 51 }, () => ({ source: "messageCount", operator: "equals", expected: "1" }));
    assert.deepEqual(fields(channelProblems({ expectations: { checks: any(tooMany) } }, CEILINGS)), ["expectations.checks"]);
    const checks = channelProblems(
      {
        expectations: {
          checks: any([
            null,
            {
              source: "message",
              operator: "equals",
              match: { at: "middle", index: -1, topic: "a/#/b", event: " " },
            },
            { source: "message", operator: "equals", match: { at: "any", index: 2, topic: "a/+", event: "chat" } },
          ]),
        },
      },
      CEILINGS,
    );
    assert.deepEqual(fields(checks), [
      "expectations.checks.0.source",
      "expectations.checks.0.operator",
      "expectations.checks.1.match.at",
      "expectations.checks.1.match.index",
      "expectations.checks.1.match.topic",
      "expectations.checks.1.match.event",
    ]);
  });

  test("tramas guardadas: lista, tope, nombre y cuerpo", () => {
    assert.deepEqual(fields(channelProblems({ messages: any("x") }, CEILINGS)), ["messages"]);
    const many = Array.from({ length: 31 }, () => ({ name: "a", body: "" }));
    assert.deepEqual(fields(channelProblems({ messages: many }, CEILINGS)), ["messages"]);
    assert.deepEqual(
      channelProblems({ messages: any([{ name: " ", body: 1 }, { name: "a", body: "x".repeat(64 * 1024 + 1) }]) }, CEILINGS),
      [
        { field: "messages.0.name", detail: "La trama necesita un nombre" },
        { field: "messages.0.body", detail: "El cuerpo de la trama es texto" },
        { field: "messages.1.body", detail: "Como mucho 64 KB" },
      ],
    );
  });

  test("un canal nuevo según su protocolo, y los cambios aplicados sin pisar lo demás", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const base = { id: "c", projectId: "p", name: " n ", url: " u ", now, by: "u1" };
    const grpc = blankChannel({ ...base, protocol: "grpc" });
    assert.deepEqual(grpc.expectations, { status: 0 });
    assert.ok(grpc.grpc);
    assert.equal(grpc.mqtt, null);
    const socketio = blankChannel({ ...base, protocol: "socketio" });
    assert.deepEqual(socketio.socketio, DEFAULT_SOCKETIO);
    assert.equal(socketio.name, "n");

    const later = new Date("2026-01-02T00:00:00Z");
    const changed = withChanges(
      grpc,
      {
        name: " otro ",
        url: " grpc://x ",
        subprotocols: [],
        auth: null,
        limits: { maxMessages: 5 },
        expectations: {},
        messages: [],
        grpc: { service: "a.B" },
        mqtt: { clientId: "no aplica" },
        socketio: { path: "/no" },
      },
      later,
      "u2",
    );
    assert.equal(changed.name, "otro");
    assert.equal(changed.url, "grpc://x");
    assert.equal(changed.auth, null);
    assert.equal(changed.limits.maxMessages, 5);
    assert.equal(changed.limits.idleMs, DEFAULT_LIMITS.idleMs);
    assert.equal(changed.grpc?.service, "a.B");
    assert.equal(changed.mqtt, null);
    assert.equal(changed.socketio, null);
    assert.equal(changed.updatedBy, "u2");

    const sio = withChanges(socketio, { socketio: { path: "/io", query: [{ name: "token", value: "t", enabled: true }] } }, later, "u");
    assert.equal(sio.socketio?.path, "/io");
    assert.equal(sio.socketio?.query[0].value, "");
    // Un canal que no es gRPC ignora los ajustes de gRPC al aplicar.
    assert.equal(withChanges(socketio, { grpc: { service: "x" } }, later, "u").grpc, null);
  });

  test("una cabecera con credencial: vacía si es a mano, tal cual si es una variable con su esquema", () => {
    const header = (name: string, value: string) => storableHeader({ name, value, enabled: true }).value;
    assert.equal(header("Authorization", "Bearer eyJ"), "");
    assert.equal(header("Authorization", "Bearer {{token}}"), "Bearer {{token}}");
    assert.equal(header("Authorization", "{{a}}-{{b}}x"), "");
    assert.equal(header("x-api-key-bin", "AQID"), "");
    assert.equal(header("x-trace", "abc"), "abc");
    assert.equal(header("authorization", "  "), "  ");
  });

  test("todo junto: un canal MQTT con sus ajustes pasa por las tres validaciones", () => {
    const input: ChannelInput = {
      protocol: "mqtt",
      url: "mqtts://broker:8883",
      mqtt: { version: 5, subscriptions: [{ topic: "a/+", qos: 1 }], userProperties: [{ name: "a", value: "b" }] },
      messages: [{ name: "m", body: "x", topic: "a/b", qos: 1, retain: false }],
    };
    assert.deepEqual(channelProblems(input, CEILINGS), []);
  });
});
