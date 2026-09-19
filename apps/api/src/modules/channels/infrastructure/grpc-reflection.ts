/**
 * La reflexión de un servidor gRPC: preguntarle qué servicios tiene y cómo son sus mensajes.
 *
 * Escrita aquí sobre grpc-js y proto-loader, y no con un cliente de terceros, porque es poco —una
 * conversación de cuatro preguntas por un stream bidireccional— y porque así sale por el mismo
 * cliente fijado a la IP comprobada que la llamada de verdad: un cliente de reflexión con su propia
 * conexión sería una segunda puerta a la red que la guarda no vigila.
 *
 * Primero `v1`; si el servidor contesta `UNIMPLEMENTED`, `v1alpha`, que es la que siguen teniendo
 * muchos servidores. Los mensajes son los mismos en las dos: solo cambia el paquete.
 */
import * as protobuf from "protobufjs";
import { fromJSON, type MethodDefinition } from "@grpc/proto-loader";
import { status as grpcStatus, type Client, type Metadata, type ServiceError } from "@grpc/grpc-js";

import { schemaFromDescriptors, type GrpcSchema } from "../domain/grpc-schema";

/** Lo justo del `reflection.proto` oficial: lo que se pregunta y lo que se lee de la respuesta. */
const REFLECTION_PROTO = (pkg: string) => `
syntax = "proto3";
package ${pkg};
service ServerReflection {
  rpc ServerReflectionInfo(stream ServerReflectionRequest) returns (stream ServerReflectionResponse);
}
message ServerReflectionRequest {
  string host = 1;
  oneof message_request {
    string file_by_filename = 3;
    string file_containing_symbol = 4;
    string list_services = 7;
  }
}
message ServerReflectionResponse {
  string valid_host = 1;
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse { int32 error_code = 1; string error_message = 2; }
`;

type ReflectionRequest = {
  host?: string;
  file_by_filename?: string;
  file_containing_symbol?: string;
  list_services?: string;
};
type ReflectionResponse = {
  file_descriptor_response?: { file_descriptor_proto: Buffer[] };
  list_services_response?: { service: { name: string }[] };
  error_response?: { error_code: number; error_message: string };
};

function definitionFor(pkg: string): MethodDefinition<ReflectionRequest, ReflectionResponse> {
  const root = new protobuf.Root();
  protobuf.parse(REFLECTION_PROTO(pkg), root, { keepCase: true });
  // Aquí los bytes se quieren como bytes: son descriptores que se vuelven a decodificar.
  const definitions = fromJSON(root.toJSON(), { keepCase: true, defaults: true, oneofs: true });
  return (
    definitions[`${pkg}.ServerReflection`] as Record<string, MethodDefinition<ReflectionRequest, ReflectionResponse>>
  ).ServerReflectionInfo;
}

/** Cuántos ficheros se piden como mucho: un servidor con miles de dependencias no es una prueba. */
const MAX_FILES = 500;

/** Un error de la reflexión que se enseña tal cual: dice qué contestó el servidor. */
export class ReflectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReflectionError";
  }
}

/** La reflexión v1, y la v1alpha si el servidor no tiene la otra: hay muchos que solo hablan esa. */
export async function reflectSchema(client: Client, metadata: Metadata, timeoutMs: number): Promise<GrpcSchema> {
  try {
    return await reflectWith(client, metadata, timeoutMs, "grpc.reflection.v1");
  } catch (error) {
    if (!unimplemented(error)) throw failed(error);
  }
  try {
    return await reflectWith(client, metadata, timeoutMs, "grpc.reflection.v1alpha");
  } catch (error) {
    if (unimplemented(error))
      throw new ReflectionError("El servidor no tiene la reflexión activada: sube los .proto del servicio");
    throw failed(error);
  }
}

const unimplemented = (error: unknown): boolean => (error as Partial<ServiceError>).code === grpcStatus.UNIMPLEMENTED;

/**
 * Lo que falló, dicho como un fallo de la reflexión. Todo lo que llega aquí es un `Error`: el estado
 * de grpc-js (con su `details`), un `ReflectionError` propio o lo que lanza protobufjs al leer.
 */
const failed = (error: unknown): ReflectionError =>
  error instanceof ReflectionError
    ? error
    : new ReflectionError(
        `La reflexión falló: ${(error as Partial<ServiceError>).details || (error as Error).message}`,
      );

/**
 * La conversación: la lista de servicios, el fichero de cada uno, y los `import` que falten.
 *
 * Un servidor manda con el fichero de un símbolo sus dependencias —casi siempre—; los que no, se
 * piden por nombre hasta que no falte ninguno. Una pregunta y una respuesta cada vez, en orden.
 */
async function reflectWith(client: Client, metadata: Metadata, timeoutMs: number, pkg: string): Promise<GrpcSchema> {
  const { path, requestSerialize, responseDeserialize } = definitionFor(pkg);
  const stream = client.makeBidiStreamRequest(path, requestSerialize, responseDeserialize, metadata, {
    deadline: Date.now() + timeoutMs,
  });

  const waiting: { resolve: (value: ReflectionResponse) => void; reject: (error: unknown) => void }[] = [];
  let failure: unknown = null;
  stream.on("data", (response: ReflectionResponse) => waiting.shift()?.resolve(response));
  stream.on("error", (error: unknown) => {
    failure = error;
    for (const pending of waiting.splice(0)) pending.reject(error);
  });
  const ask = (request: ReflectionRequest) =>
    new Promise<ReflectionResponse>((resolve, reject) => {
      // Un error entre dos preguntas: grpc-js lo entrega en otra vuelta, cuando la siguiente ya espera
      // y la rechaza. Se mira por si acaso: escribir en un stream caído colgaría la reflexión.
      /* node:coverage ignore next 3 */
      if (failure) {
        return reject(failure);
      }
      waiting.push({ resolve, reject });
      stream.write({ host: "", ...request });
    });

  try {
    const listed = await ask({ list_services: "*" });
    if (listed.error_response) throw new ReflectionError(listed.error_response.error_message);
    const services = (listed.list_services_response?.service ?? [])
      .map((service) => service.name)
      .filter((name) => !name.startsWith("grpc.reflection."));

    const files = new Map<string, Buffer>();
    const needed: string[] = [];
    const take = (response: ReflectionResponse) => {
      if (response.error_response) throw new ReflectionError(response.error_response.error_message);
      for (const bytes of response.file_descriptor_response?.file_descriptor_proto ?? []) {
        const file = decodeFile(bytes);
        if (files.has(file.name)) continue;
        files.set(file.name, bytes);
        needed.push(...file.dependencies);
      }
    };
    for (const service of services) take(await ask({ file_containing_symbol: service }));
    while (needed.length) {
      const name = needed.shift()!;
      if (files.has(name)) continue;
      if (files.size >= MAX_FILES) throw new ReflectionError(`El servidor describe más de ${MAX_FILES} ficheros`);
      take(await ask({ file_by_filename: name }));
    }
    return schemaFromDescriptors([...files.values()]);
  } finally {
    stream.end();
    stream.cancel();
  }
}

/** El nombre y las dependencias de un `FileDescriptorProto`: los campos 1 y 3, sin decodificar el resto. */
function decodeFile(bytes: Uint8Array): { name: string; dependencies: string[] } {
  const reader = protobuf.Reader.create(bytes);
  let name = "";
  const dependencies: string[] = [];
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const field = tag >>> 3;
    if (field === 1) name = reader.string();
    else if (field === 3) dependencies.push(reader.string());
    else reader.skipType(tag & 7);
  }
  return { name, dependencies };
}
