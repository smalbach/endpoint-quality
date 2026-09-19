/**
 * La definición de un servicio gRPC, leída de `.proto` o de lo que contesta la reflexión.
 *
 * Las dos entradas acaban en lo mismo —un `Root` de protobufjs— y a partir de ahí todo es común: la
 * lista de servicios y métodos para el selector, el mensaje de ejemplo, la comprobación del JSON
 * que alguien escribió y la definición que `@grpc/grpc-js` necesita para llamar. Sin E/S: los
 * `.proto` llegan ya leídos y los descriptores de la reflexión ya recibidos.
 *
 * **Los nombres de campo se quedan como en el `.proto`** (`keepCase`): `item_id` y no `itemId`. Es
 * lo que la gente copia del fichero, lo que sale en el ejemplo y lo que se lee en la respuesta; con
 * dos grafías para el mismo campo, una comprobación escrita con una no casa con la otra.
 */
import * as protobuf from "protobufjs";
// Por su efecto: añade `Root.fromDescriptor`, que es cómo se leen los descriptores de la reflexión.
import "protobufjs/ext/descriptor";
import descriptorJson from "protobufjs/google/protobuf/descriptor.json";
import apiJson from "protobufjs/google/protobuf/api.json";
import typeJson from "protobufjs/google/protobuf/type.json";
import sourceContextJson from "protobufjs/google/protobuf/source_context.json";
import { fromJSON, type MethodDefinition, type Options } from "@grpc/proto-loader";

import type { ProtoFile } from "./grpc";

/**
 * Cómo se convierte un mensaje en JSON al leerlo: los `int64` como texto —un número de JavaScript
 * no los aguanta enteros—, los enums por su nombre, los bytes en base64 y los campos sin valor con su
 * valor por omisión, para que una comprobación sobre `count` vea el 0 que el cable no manda.
 */
const LOADER_OPTIONS: Options = {
  keepCase: true,
  longs: String,
  enums: String,
  bytes: String,
  defaults: true,
  oneofs: false,
  json: true,
};

/** Los tipos bien conocidos que no hace falta subir: los que trae protobufjs, más `descriptor`. */
const WELL_KNOWN: Record<string, protobuf.INamespace> = {
  "google/protobuf/descriptor.proto": descriptorJson as protobuf.INamespace,
  "google/protobuf/api.proto": apiJson as protobuf.INamespace,
  "google/protobuf/type.proto": typeJson as protobuf.INamespace,
  "google/protobuf/source_context.proto": sourceContextJson as protobuf.INamespace,
};

function wellKnown(path: string): protobuf.INamespace | null {
  const bundled = protobuf.common.get(path) as protobuf.INamespace | null;
  return bundled ?? WELL_KNOWN[path] ?? null;
}

/** Un `.proto` que no se pudo leer, con el fichero y lo que dijo el analizador. */
export class ProtoSchemaError extends Error {
  constructor(
    message: string,
    readonly field: string = "files",
  ) {
    super(message);
    this.name = "ProtoSchemaError";
  }
}

export type GrpcMethodView = {
  name: string;
  requestType: string;
  responseType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  /** Declarado `idempotency_level = NO_SIDE_EFFECTS`: el único que se puede invocar sin escrituras. */
  readOnly: boolean;
  /** El mensaje de entrada con cada campo a su valor por omisión, en JSON con sangría. */
  example: string;
};

export type GrpcServiceView = { name: string; methods: GrpcMethodView[] };

/** Los servicios de la propia reflexión: están en el servidor, pero no son lo que se prueba. */
const REFLECTION_SERVICES = new Set([
  "grpc.reflection.v1.ServerReflection",
  "grpc.reflection.v1alpha.ServerReflection",
]);

export type ResolvedMethod = {
  service: string;
  method: protobuf.Method;
  requestType: protobuf.Type;
  responseType: protobuf.Type;
  definition: MethodDefinition<object, object>;
};

export class GrpcSchema {
  private definitions: ReturnType<typeof fromJSON> | null = null;

  constructor(readonly root: protobuf.Root) {}

  services(): GrpcServiceView[] {
    return collectServices(this.root)
      .filter((service) => !REFLECTION_SERVICES.has(fullName(service)))
      .map((service) => ({
        name: fullName(service),
        methods: service.methodsArray.map((method) => {
          method.resolve();
          const requestType = method.resolvedRequestType as protobuf.Type;
          return {
            name: method.name,
            requestType: fullName(requestType),
            responseType: fullName(method.resolvedResponseType as protobuf.Type),
            clientStreaming: Boolean(method.requestStream),
            serverStreaming: Boolean(method.responseStream),
            readOnly: isReadOnly(method),
            example: JSON.stringify(exampleOf(requestType), null, 2),
          };
        }),
      }));
  }

  /** El método por su servicio y su nombre, con lo que hace falta para llamarlo. `null` si no está. */
  method(service: string, name: string): ResolvedMethod | null {
    let found: protobuf.Service;
    try {
      found = this.root.lookupService(service);
    } catch {
      return null;
    }
    const method = found.methods[name];
    if (!method) return null;
    method.resolve();
    // La definición de proto-loader se hace una vez por esquema: recorre el árbol entero.
    this.definitions ??= fromJSON(this.root.toJSON(), LOADER_OPTIONS);
    const definition = (this.definitions[fullName(found)] as Record<string, MethodDefinition<object, object>>)[name];
    return {
      service: fullName(found),
      method,
      requestType: method.resolvedRequestType as protobuf.Type,
      responseType: method.resolvedResponseType as protobuf.Type,
      definition,
    };
  }
}

/**
 * Un conjunto de `.proto` subidos, leído entero.
 *
 * Los `import` se resuelven **dentro del conjunto**: por la ruta exacta, o por el final de la ruta
 * cuando es único —quien sube `protos/comun/dinero.proto` lo importa como `comun/dinero.proto`, que
 * es como se lo importa su compilador con `-I protos`—. Los de `google/protobuf/` que trae
 * protobufjs no hace falta subirlos. Lo que falta se nombra con el fichero que lo pide.
 */
export function schemaFromFiles(files: ProtoFile[]): GrpcSchema {
  const root = new protobuf.Root();
  const byPath = new Map(files.map((file) => [file.path, file]));
  const loaded = new Set<string>();
  const pending = [...files.map((file) => file.path)];

  const locate = (wanted: string, from: string): string | null => {
    if (byPath.has(wanted)) return wanted;
    const matches = files.filter((file) => file.path.endsWith(`/${wanted}`));
    if (matches.length === 1) return matches[0].path;
    if (matches.length > 1)
      throw new ProtoSchemaError(`${from}: el import «${wanted}» casa con más de un fichero subido`);
    return null;
  };

  while (pending.length) {
    const path = pending.shift()!;
    if (loaded.has(path)) continue;
    loaded.add(path);
    const known = wellKnown(path);
    if (known && !byPath.has(path)) {
      try {
        root.addJSON(known.nested ?? {});
      } catch (error) {
        // Un fichero subido que define un tipo de `google.protobuf` que otro importa del paquete: el
        // mismo nombre dos veces. Es un conjunto que no se lee —un 422 que lo dice—, no un 500.
        // protobufjs solo lanza `Error`.
        throw new ProtoSchemaError(`${path} choca con un tipo de los ficheros subidos: ${(error as Error).message}`);
      }
      continue;
    }
    const file = byPath.get(path)!;
    let parsed: protobuf.IParserResult;
    try {
      // `parse.filename` es cómo protobufjs pone el fichero en sus mensajes de error: sin él, un
      // error de sintaxis en uno de cuarenta ficheros no dice en cuál.
      (protobuf.parse as unknown as { filename: string | null }).filename = path;
      parsed = protobuf.parse(file.content, root, { keepCase: true, alternateCommentMode: true });
    } catch (error) {
      throw new ProtoSchemaError(error instanceof Error ? error.message : String(error));
    } finally {
      (protobuf.parse as unknown as { filename: string | null }).filename = null;
    }
    for (const wanted of [...(parsed.imports ?? []), ...(parsed.weakImports ?? [])]) {
      const found = locate(wanted, path);
      if (found) pending.push(found);
      else if (wellKnown(wanted)) pending.push(wanted);
      else throw new ProtoSchemaError(`${path} importa «${wanted}», que no está entre los ficheros subidos`);
    }
  }

  return finish(root);
}

/**
 * Lo que contestó la reflexión: `FileDescriptorProto` en binario, uno por fichero.
 *
 * Se juntan en un `FileDescriptorSet` —que en el cable es exactamente eso: cada fichero como campo
 * 1— y protobufjs lo convierte en el mismo `Root` que sale de los `.proto`.
 */
export function schemaFromDescriptors(files: Uint8Array[]): GrpcSchema {
  const writer = protobuf.Writer.create();
  for (const file of files) writer.uint32(10).bytes(file);
  let root: protobuf.Root;
  try {
    root = (protobuf.Root as unknown as { fromDescriptor(set: Uint8Array): protobuf.Root }).fromDescriptor(
      writer.finish(),
    );
  } catch (error) {
    // protobufjs solo lanza `Error` al decodificar.
    throw new ProtoSchemaError(
      `La reflexión devolvió descriptores que no se pudieron leer: ${(error as Error).message}`,
    );
  }
  return finish(root);
}

function finish(root: protobuf.Root): GrpcSchema {
  try {
    root.resolveAll();
  } catch (error) {
    throw new ProtoSchemaError(error instanceof Error ? error.message : String(error));
  }
  return new GrpcSchema(root);
}

function collectServices(namespace: protobuf.NamespaceBase): protobuf.Service[] {
  const found: protobuf.Service[] = [];
  for (const nested of namespace.nestedArray) {
    if (nested instanceof protobuf.Service) found.push(nested);
    else if (nested instanceof protobuf.Namespace) found.push(...collectServices(nested));
  }
  return found.sort((a, b) => fullName(a).localeCompare(fullName(b)));
}

/** El nombre con su paquete y sin el punto inicial con el que protobufjs lo escribe. */
const fullName = (object: protobuf.ReflectionObject): string => object.fullName.replace(/^\./, "");

/** Declarado `idempotency_level = NO_SIDE_EFFECTS`: el único que se invoca en un entorno sin escrituras. */
export function isReadOnly(method: protobuf.Method): boolean {
  const level = method.options?.["idempotency_level"] ?? method.options?.["idempotencyLevel"];
  return level === "NO_SIDE_EFFECTS" || level === 1;
}

/**
 * Un mensaje de ejemplo: cada campo con su valor por omisión, que es lo que Postman llama «generar
 * ejemplo».
 *
 * De cada `oneof` solo el primero, porque mandar dos es un mensaje que el servidor rechaza. Un campo
 * cuyo tipo ya está más arriba —un árbol, un comentario con respuestas— se omite: el ejemplo es para
 * empezar a escribir, no un volcado infinito.
 */
export function exampleOf(type: protobuf.Type, seen: string[] = []): Record<string, unknown> {
  const example: Record<string, unknown> = {};
  const skipped = new Set<string>();
  for (const oneof of type.oneofsArray) {
    // Los `optional` de proto3 son un oneof sintético de un solo campo: no se elige entre nada.
    if (oneof.fieldsArray.length > 1) for (const field of oneof.fieldsArray.slice(1)) skipped.add(field.name);
  }
  for (const field of type.fieldsArray) {
    if (skipped.has(field.name)) continue;
    field.resolve();
    const value = exampleValue(field, [...seen, type.fullName]);
    if (value === undefined) continue;
    if (field.map)
      example[field.name] = { [(field as unknown as protobuf.MapField).keyType === "string" ? "clave" : "0"]: value };
    else example[field.name] = field.repeated ? [value] : value;
  }
  return example;
}

function exampleValue(field: protobuf.Field, seen: string[]): unknown {
  const resolved = field.resolvedType;
  if (resolved instanceof protobuf.Enum) return Object.keys(resolved.values)[0] ?? 0;
  if (resolved instanceof protobuf.Type) {
    if (seen.includes(resolved.fullName)) return undefined;
    return exampleOf(resolved, seen);
  }
  switch (field.type) {
    case "string":
      return "";
    case "bytes":
      return "";
    case "bool":
      return false;
    case "int64":
    case "uint64":
    case "sint64":
    case "fixed64":
    case "sfixed64":
      return "0";
    default:
      return 0;
  }
}

/**
 * Lo que sobra en un mensaje escrito a mano: los campos que el tipo no tiene.
 *
 * `fromObject` los ignora sin decir nada, y un `itemId` donde el `.proto` dice `item_id` sería un
 * mensaje que sale vacío y un servidor que contesta «falta el id» sin que nadie sepa por qué.
 */
export function unknownFields(type: protobuf.Type, value: unknown, path = ""): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const found: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    const field = type.fields[key];
    if (!field) {
      found.push(here);
      continue;
    }
    field.resolve();
    if (!(field.resolvedType instanceof protobuf.Type) || field.map) continue;
    // Los tipos bien conocidos con forma propia en JSON (`Any`) los resuelve protobufjs a su manera.
    if (field.resolvedType.fullName === ".google.protobuf.Any") continue;
    const nested = field.resolvedType;
    if (field.repeated && Array.isArray(item))
      item.forEach((entry, index) => found.push(...unknownFields(nested, entry, `${here}[${index}]`)));
    else found.push(...unknownFields(nested, item, here));
  }
  return found;
}

/**
 * El JSON de un mensaje, comprobado contra su tipo: `null` si vale, o por qué no.
 *
 * `fromObject` convierte lo que puede —un número escrito como texto en un `int64`, un enum por su
 * nombre— y lanza con lo que no; lo que no mira es lo que sobra, y eso lo dice `unknownFields`.
 */
export function messageProblem(type: protobuf.Type, value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return `El mensaje de ${fullName(type)} es un objeto JSON`;
  const extra = unknownFields(type, value);
  if (extra.length)
    return `${fullName(type)} no tiene ${extra.length > 1 ? "los campos" : "el campo"} ${extra.join(", ")}`;
  try {
    type.fromObject(value as Record<string, unknown>);
    return null;
  } catch (error) {
    return `El mensaje no encaja con ${fullName(type)}: ${error instanceof Error ? error.message : error}`;
  }
}
