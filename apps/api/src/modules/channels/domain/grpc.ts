/**
 * Un canal gRPC: lo que tiene que saber además de una URL y unas cabeceras.
 *
 * Es un canal y no un endpoint por lo mismo que un WebSocket: una llamada con streams es una
 * conversación —mensajes en las dos direcciones que llegan cuando llegan— y termina con un estado y
 * unos trailers en vez de con una respuesta. La unaria es el caso de un solo mensaje en cada
 * sentido, y cabe en la misma transcripción sin inventar nada.
 *
 * Lo que vive aquí es solo lo de gRPC: la forma de sus ajustes, la validación de su URL y de su
 * metadata, y los topes de los `.proto` que se guardan con el canal. Lo que es de todos los canales
 * —nombre, cabeceras, autenticación, topes de la sesión— sigue en `model.ts`.
 */
import type { StepCheck } from "@eq/runner-core";

type Problem = { field: string; detail: string };

/** De dónde sale la definición del servicio. */
export const GRPC_SOURCES = ["proto", "reflection"] as const;
export type GrpcSource = (typeof GRPC_SOURCES)[number];

export type GrpcSettings = {
  /**
   * `proto`: los ficheros subidos con el canal. `reflection`: se le pregunta al servidor al abrir.
   *
   * Las dos, como Postman, porque las dos son reales: muchos servidores de producción tienen la
   * reflexión apagada, y quien sí la tiene no debería tener que subir nada.
   */
  source: GrpcSource;
  /** Nombre completo, con el paquete: `tienda.v1.Catalogo`. Vacío mientras no se haya elegido. */
  service: string;
  method: string;
  /** El mensaje de la petición: JSON con `{{variables}}`, que se resuelven contra el entorno al invocar. */
  message: string;
  /**
   * El plazo de la llamada, en milisegundos. `null` es «sin plazo propio»: la cortan los topes de
   * la sesión, que siempre están. Se manda al servidor como `grpc-timeout`, así que es también lo
   * que el servidor sabe que tiene.
   */
  deadlineMs: number | null;
};

export const DEFAULT_GRPC_SETTINGS: GrpcSettings = {
  source: "proto",
  service: "",
  method: "",
  message: "{}",
  deadlineMs: null,
};

export const GRPC_SCHEMES = ["grpc:", "grpcs:"] as const;
export const MAX_GRPC_MESSAGE_BYTES = 64 * 1024;
export const MAX_GRPC_DEADLINE_MS = 600_000;

/**
 * Los `.proto` de un canal: unos pocos ficheros de texto, con techo.
 *
 * Se guardan con el canal —y no se piden cada vez— porque una corrida o un monitor no tienen a nadie
 * delante que vuelva a subirlos. Los topes son de un conjunto de definiciones de verdad, holgados:
 * una API grande con sus dependencias cabe en pocas decenas de ficheros y bastante menos de un MB.
 */
export const MAX_PROTO_FILES = 100;
export const MAX_PROTO_FILE_BYTES = 256 * 1024;
export const MAX_PROTO_TOTAL_BYTES = 1024 * 1024;
const MAX_PROTO_PATH = 300;

export type ProtoFile = { path: string; content: string };

export const CHANNEL_PROTO_REPOSITORY = Symbol("CHANNEL_PROTO_REPOSITORY");

/**
 * Los `.proto` de cada canal. Se reemplazan enteros: un conjunto de definiciones se sube junto,
 * porque un fichero suelto que importa otro que ya no está es un conjunto roto.
 */
export interface ChannelProtoRepositoryPort {
  list(channelId: string): Promise<ProtoFile[]>;
  replace(channelId: string, files: ProtoFile[]): Promise<void>;
}

/**
 * La metadata que no escribe quien crea el canal.
 *
 * Las pseudo-cabeceras de HTTP/2 y las `grpc-*` son el propio protocolo —`grpc-timeout` es el plazo,
 * `grpc-status` el estado—; `content-type`, `te` y `user-agent` las pone la biblioteca. Fijarlas a
 * mano es romper la llamada y descubrirlo al invocar con un error que no nombra la cabecera.
 */
const RESERVED_METADATA = new Set(["host", "content-type", "te", "user-agent", "connection", "transfer-encoding"]);

/** Una clave de metadata: minúsculas, dígitos y `-_.`. Mayúsculas se aceptan y viajan en minúsculas. */
const METADATA_KEY = /^[0-9a-zA-Z_.-]+$/;

export function isReservedMetadata(name: string): boolean {
  const key = name.toLowerCase();
  return key.startsWith(":") || key.startsWith("grpc-") || RESERVED_METADATA.has(key);
}

/** Lo que no puede llevar una clave de metadata, dicho con la clave. `null` si está bien. */
export function metadataKeyProblem(name: string): string | null {
  if (!METADATA_KEY.test(name)) return "Una clave de metadata lleva letras, dígitos y - _ .";
  if (isReservedMetadata(name)) return `${name} la pone el protocolo, no se escribe a mano`;
  // Las `-bin` viajan como bytes, y aquí se escribe texto: aceptarlas sería mandar otra cosa que lo
  // que se ve en la pantalla.
  if (name.toLowerCase().endsWith("-bin")) return "La metadata binaria (-bin) no se admite: solo texto";
  return null;
}

/**
 * La URL de un canal gRPC: `grpc://` sin cifrar o `grpcs://` con TLS, y solo el anfitrión y el puerto.
 *
 * El esquema dice el TLS, y no un interruptor aparte, para que la URL sola baste para saber cómo se
 * conecta —en una lista, en un informe, en un fichero exportado—. Con `{{variables}}` no se puede
 * mirar más que lo que ninguna URL lleva; la guarda de red vuelve a mirarlo todo al conectar.
 */
export function grpcUrlProblems(url: string): Problem[] {
  if (url.includes("{{")) return [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [{ field: "url", detail: "No es una URL: empieza por grpc:// o grpcs://" }];
  }
  if (!(GRPC_SCHEMES as readonly string[]).includes(parsed.protocol))
    return [{ field: "url", detail: `Un canal gRPC empieza por grpc:// o grpcs://, no por ${parsed.protocol}//` }];
  if (parsed.username || parsed.password)
    return [{ field: "url", detail: "Las credenciales van en la autenticación, no en la URL" }];
  if (!parsed.hostname) return [{ field: "url", detail: "Falta el servidor: grpcs://api.ejemplo.com:443" }];
  // La ruta de una llamada es `/paquete.Servicio/Metodo`, y la pone el método elegido.
  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash)
    return [{ field: "url", detail: "Solo servidor y puerto: el servicio y el método se eligen aparte" }];
  return [];
}

/** El puerto de una URL gRPC: el escrito, o el de siempre de cada esquema. */
export function grpcPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "grpcs:" ? 443 : 80;
}

export function grpcSettingsProblems(value: unknown): Problem[] {
  const problems: Problem[] = [];
  const problem = (field: string, detail: string) => problems.push({ field: `grpc.${field}`, detail });
  if (typeof value !== "object" || value === null) return [{ field: "grpc", detail: "Es un objeto" }];
  const settings = value as Partial<GrpcSettings>;
  if (settings.source !== undefined && !(GRPC_SOURCES as readonly string[]).includes(settings.source))
    problem("source", "O los .proto del canal, o la reflexión del servidor");
  for (const key of ["service", "method"] as const) {
    const text = settings[key];
    if (text === undefined) continue;
    if (typeof text !== "string" || text.length > 300 || !/^[A-Za-z0-9_.]*$/.test(text))
      problem(key, "Un nombre de protobuf: letras, dígitos, _ y .");
  }
  if (settings.message !== undefined) {
    if (typeof settings.message !== "string") problem("message", "El mensaje es texto JSON");
    else if (Buffer.byteLength(settings.message, "utf8") > MAX_GRPC_MESSAGE_BYTES)
      problem("message", `Como mucho ${MAX_GRPC_MESSAGE_BYTES / 1024} KB`);
  }
  if (settings.deadlineMs !== undefined && settings.deadlineMs !== null) {
    if (!Number.isInteger(settings.deadlineMs) || settings.deadlineMs < 1 || settings.deadlineMs > MAX_GRPC_DEADLINE_MS)
      problem("deadlineMs", `Milisegundos: un entero entre 1 y ${MAX_GRPC_DEADLINE_MS}`);
  }
  return problems;
}

/**
 * Lo que un canal gRPC afirma: el estado, los mensajes y las comprobaciones sobre ellos.
 *
 * `closeCode` es de WebSocket —1000 es «se despidió»— y aquí no significa nada; el estado de una
 * llamada se afirma con `status`, y se dice en vez de guardar una afirmación que nunca va a poder
 * pasar.
 */
export function grpcExpectationProblems(expect: { closeCode?: number; status?: number; checks?: StepCheck[] }) {
  const problems: Problem[] = [];
  if (expect.closeCode !== undefined)
    problems.push({ field: "expectations.closeCode", detail: "En gRPC se afirma el estado, no un código de cierre" });
  if (expect.status !== undefined && (!Number.isInteger(expect.status) || expect.status < 0 || expect.status > 16))
    problems.push({ field: "expectations.status", detail: "Un estado de gRPC: un entero de 0 (OK) a 16" });
  return problems;
}

/**
 * Los ficheros de un conjunto, antes de leerlos: rutas y tamaños.
 *
 * La ruta es la de los `import`, relativa y sin `..`: con ella se resuelve `import "comun/dinero.proto"`
 * contra el resto del conjunto, y una ruta que sale del conjunto no tiene nada a lo que apuntar.
 */
export function protoFilesProblems(files: unknown): Problem[] {
  if (!Array.isArray(files)) return [{ field: "files", detail: "Los ficheros son una lista" }];
  const problems: Problem[] = [];
  if (files.length > MAX_PROTO_FILES)
    problems.push({ field: "files", detail: `Como mucho ${MAX_PROTO_FILES} ficheros` });
  let total = 0;
  const seen = new Set<string>();
  files.forEach((file: Partial<ProtoFile>, index) => {
    const field = `files.${index}`;
    const path = typeof file?.path === "string" ? file.path : "";
    if (
      !path ||
      path.length > MAX_PROTO_PATH ||
      !path.endsWith(".proto") ||
      path.startsWith("/") ||
      path.split("/").some((part) => part === ".." || part === "" || part === ".") ||
      !/^[A-Za-z0-9_./-]+$/.test(path)
    )
      problems.push({ field: `${field}.path`, detail: "Una ruta relativa que acaba en .proto, sin .." });
    else if (seen.has(path)) problems.push({ field: `${field}.path`, detail: `${path} está dos veces` });
    seen.add(path);
    if (typeof file?.content !== "string") {
      problems.push({ field: `${field}.content`, detail: "El contenido es texto" });
      return;
    }
    const bytes = Buffer.byteLength(file.content, "utf8");
    total += bytes;
    if (bytes > MAX_PROTO_FILE_BYTES)
      problems.push({ field: `${field}.content`, detail: `Como mucho ${MAX_PROTO_FILE_BYTES / 1024} KB por fichero` });
  });
  if (total > MAX_PROTO_TOTAL_BYTES)
    problems.push({ field: "files", detail: `Como mucho ${MAX_PROTO_TOTAL_BYTES / 1024 / 1024} MB entre todos` });
  return problems;
}
