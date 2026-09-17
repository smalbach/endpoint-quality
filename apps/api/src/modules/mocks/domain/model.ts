/**
 * Un servidor de mocks: una URL pública que contesta con los ejemplos guardados del proyecto.
 *
 * Es lo que convierte los ejemplos de documentación en algo ejecutable. Sin esto, quien monta el
 * front espera a que la API exista; con esto apunta a esta URL y lo que le llega es **lo que la API
 * de verdad contestó una vez**, no un JSON que alguien escribió a mano imaginándose el contrato.
 *
 * ## La URL es la credencial, así que no se adivina
 *
 * `publicId` es aleatorio de 128 bits y no es el `id` de la fila. Dos razones: un mock público solo
 * está protegido por que nadie sepa su URL, y separar los dos identificadores permite rotar la URL
 * sin romper las referencias internas.
 *
 * ## Público o privado, pero **dicho**
 *
 * `visibility` no tiene valor por defecto, y eso es deliberado. Un mock sirve cuerpos de ejemplo:
 * ya van sin credenciales —eso lo hizo la redacción al guardarlos— pero siguen siendo datos reales
 * de alguien, con sus nombres, sus correos y sus identificadores. Que la opción cómoda sea la
 * abierta hace que se publique sin decidirlo. Aquí hay que elegir, y el que elige lo sabe.
 *
 * Un mock privado pide `x-api-key`. La clave **se enseña una vez** y de ella se guarda el hash, con
 * el mismo criterio que los tokens de API: un volcado de la base de datos no entrega mocks.
 */
import { randomUUID } from "node:crypto";

import { generateOpaqueToken, hashOpaqueToken, tokenPreview } from "@/shared/crypto/opaque-token";

/** Local, como en `examples.ts` y en `model.ts` de endpoints. */
type Problem = { field: string; detail: string };

/** El primer segmento de la URL servida. Fuera del dominio también lo usa el CORS del mock. */
export const MOCK_PATH_PREFIX = "mock";

export const MAX_MOCK_NAME = 120;
/** Diez por proyecto. Más son mocks olvidados, y cada uno es una URL pública viva. */
export const MAX_MOCKS_PER_PROJECT = 10;
/**
 * El retardo máximo que se puede simular.
 *
 * No es una cifra de gusto: mientras el mock espera tiene un socket y un manejador ocupados, así
 * que un retardo largo multiplicado por las peticiones de un front en bucle tumba el proceso. Cinco
 * segundos bastan para lo que se prueba con esto —el esqueleto de carga, el `timeout` del cliente—
 * y no llegan para hacer daño.
 */
export const MAX_MOCK_DELAY_MS = 5_000;

export const MOCK_VISIBILITIES = ["public", "private"] as const;
export type MockVisibility = (typeof MOCK_VISIBILITIES)[number];

/**
 * El retardo simulado.
 *
 * `random` existe porque una latencia constante no reproduce el fallo que se busca: un front que
 * lanza tres peticiones y pinta según el orden de llegada funciona perfecto con 200 ms fijos y se
 * rompe en cuanto una tarda más que otra.
 */
export type MockDelay =
  { kind: "none" } | { kind: "fixed"; ms: number } | { kind: "random"; minMs: number; maxMs: number };

export const NO_DELAY: MockDelay = { kind: "none" };

export type MockServer = {
  id: string;
  projectId: string;
  name: string;
  /** El segmento opaco de la URL. Único en toda la instalación, no solo en el proyecto. */
  publicId: string;
  visibility: MockVisibility;
  /** SHA-256 de la clave. Nulo en un mock público, que no tiene clave. */
  apiKeyHash: string | null;
  /** Los primeros y los últimos caracteres, para distinguir dos claves sin revelar ninguna. */
  apiKeyPreview: string;
  delay: MockDelay;
  /** Apagado contesta 503 y lo dice. Es lo que se quiere cuando un mock hace ruido y no se quiere
   * perder su configuración para volver a encenderlo mañana. */
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
};

export type MockInput = {
  name?: string;
  visibility?: MockVisibility;
  delay?: MockDelay;
  enabled?: boolean;
};

/** 128 bits en base64url: 22 caracteres que caben en una URL y no se teclean a mano. */
export function newPublicId(): string {
  return generateOpaqueToken(16);
}

export function mockProblems(input: MockInput, { requireVisibility = false } = {}): Problem[] {
  const problems: Problem[] = [];
  const problem = (field: string, detail: string) => problems.push({ field, detail });

  if (input.name !== undefined) {
    if (!input.name.trim()) problem("name", "Falta el nombre");
    else if (input.name.length > MAX_MOCK_NAME) problem("name", `Como mucho ${MAX_MOCK_NAME} caracteres`);
  }

  if (requireVisibility && input.visibility === undefined) {
    // Sin valor por defecto a propósito: publicar los ejemplos de un proyecto es una decisión, y
    // una decisión que se toma por omisión no se ha tomado.
    problem("visibility", "Di si el mock es «public» o «private»");
  }
  if (input.visibility !== undefined && !MOCK_VISIBILITIES.includes(input.visibility))
    problem("visibility", "Tiene que ser «public» o «private»");

  const delay = input.delay;
  if (delay !== undefined) {
    if (delay.kind === "fixed") {
      if (!Number.isInteger(delay.ms) || delay.ms < 0) problem("delay.ms", "Tiene que ser un entero de 0 o más");
      else if (delay.ms > MAX_MOCK_DELAY_MS) problem("delay.ms", `Como mucho ${MAX_MOCK_DELAY_MS} ms`);
    } else if (delay.kind === "random") {
      const bad = (field: "minMs" | "maxMs") => {
        const value = delay[field];
        if (!Number.isInteger(value) || value < 0)
          return problem(`delay.${field}`, "Tiene que ser un entero de 0 o más");
        if (value > MAX_MOCK_DELAY_MS) return problem(`delay.${field}`, `Como mucho ${MAX_MOCK_DELAY_MS} ms`);
      };
      bad("minMs");
      bad("maxMs");
      if (Number.isInteger(delay.minMs) && Number.isInteger(delay.maxMs) && delay.minMs > delay.maxMs)
        problem("delay.minMs", "El mínimo no puede ser mayor que el máximo");
    } else if (delay.kind !== "none") {
      problem("delay.kind", "Tiene que ser «none», «fixed» o «random»");
    }
  }

  return problems;
}

/** Cuánto esperar esta vez. `random` se resuelve por petición, que es el punto de que sea random. */
export function delayFor(delay: MockDelay, random: () => number = Math.random): number {
  if (delay.kind === "fixed") return delay.ms;
  if (delay.kind === "random") return delay.minMs + Math.floor(random() * (delay.maxMs - delay.minMs + 1));
  return 0;
}

/** Lo que se crea, más la clave en claro cuando es privado — que se devuelve una vez y nunca más. */
export type NewMock = { mock: MockServer; apiKey: string | null };

export function blankMock(fields: {
  projectId: string;
  name: string;
  visibility: MockVisibility;
  delay?: MockDelay;
  now: Date;
  actorId: string;
}): NewMock {
  const apiKey = fields.visibility === "private" ? generateOpaqueToken(32) : null;
  return {
    apiKey,
    mock: {
      id: randomUUID(),
      projectId: fields.projectId,
      name: fields.name,
      publicId: newPublicId(),
      visibility: fields.visibility,
      apiKeyHash: apiKey ? hashOpaqueToken(apiKey) : null,
      apiKeyPreview: apiKey ? tokenPreview(apiKey) : "",
      delay: fields.delay ?? NO_DELAY,
      enabled: true,
      createdAt: fields.now,
      updatedAt: fields.now,
      createdBy: fields.actorId,
    },
  };
}

/** Una clave nueva para un mock privado. La vieja deja de valer en el mismo momento. */
export function rotatedKey(mock: MockServer, now: Date): { mock: MockServer; apiKey: string } {
  const apiKey = generateOpaqueToken(32);
  return {
    apiKey,
    mock: { ...mock, apiKeyHash: hashOpaqueToken(apiKey), apiKeyPreview: tokenPreview(apiKey), updatedAt: now },
  };
}

/** Lo que sale por la API. Sin el hash: no hace falta para nada y es lo único secreto que hay. */
export type MockServerView = Omit<MockServer, "projectId" | "apiKeyHash" | "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};

export function viewMock(mock: MockServer): MockServerView {
  const { projectId: _projectId, apiKeyHash: _apiKeyHash, ...rest } = mock;
  return { ...rest, createdAt: mock.createdAt.toISOString(), updatedAt: mock.updatedAt.toISOString() };
}
