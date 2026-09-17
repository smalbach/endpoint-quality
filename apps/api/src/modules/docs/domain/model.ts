/**
 * Un sitio de documentación publicada: una URL que enseña los endpoints de un proyecto.
 *
 * Es el otro consumidor de los ejemplos guardados, y el que cierra el círculo. El mock los sirve
 * para que una máquina los consuma; esto los enseña para que **una persona de otro equipo** entienda
 * la API sin que nadie le explique nada y sin darle acceso a este producto.
 *
 * ## Lo que se publica es una proyección, no el endpoint
 *
 * Un endpoint guardado lleva dentro cosas que existen para poder *enviar* la petición: los
 * parámetros de su autenticación, las cabeceras que alguien escribió a mano —`Authorization: Bearer
 * eyJ…` entre ellas—, el cuerpo con el que se probó y dos scripts. Publicar el endpoint sería
 * publicar todo eso. Así que lo que sale por la URL pública lo construye `doc-page.ts` con una
 * **lista de lo que entra**, no de lo que se quita: un campo nuevo en `Endpoint` no aparece en la
 * documentación hasta que alguien lo añada a mano ahí. Al contrario —una lista de lo que se quita—
 * el campo nuevo se publicaría solo, que es exactamente cómo se filtran las cosas.
 *
 * ## La URL base se escribe aquí, no se saca de un entorno
 *
 * La documentación necesita una URL base para que el `curl` de la página se pueda pegar. La
 * tentación es leerla del entorno activo del proyecto, y es justo lo que no se puede hacer: un
 * entorno tiene `{{token}}`, `{{apiKey}}` y el host interno de preproducción, y resolver variables
 * contra él para pintar una página pública es publicar sus valores. Así que este sitio tiene **su
 * propia** URL base, escrita a mano por quien publica, y las variables de la documentación se
 * quedan escritas como `{{variable}}`.
 *
 * ## Público o privado, y los ejemplos aparte
 *
 * Como en los mocks, `visibility` no tiene valor por defecto. Y hay una segunda decisión que no es
 * la misma: **los cuerpos de ejemplo**. Van sin credenciales —eso lo hizo la redacción al
 * guardarlos— pero siguen siendo respuestas reales, con nombres, correos e identificadores de
 * alguien. Por eso `includeExamples` empieza en `false`: publicar la forma de la API es una cosa y
 * publicar sus datos es otra, y la que arrastra datos no puede ser la que pasa sin mirarse.
 */
import { randomUUID } from "node:crypto";

import { generateOpaqueToken, hashOpaqueToken, tokenPreview } from "@/shared/crypto/opaque-token";

/** Local, como en `examples.ts` y en el `model.ts` de endpoints. */
type Problem = { field: string; detail: string };

/**
 * El primer segmento de la URL pública **del navegador**, que es la que se le da a una persona.
 *
 * No es la ruta de la API: la página la pinta el programa del navegador, y los datos los lee de
 * `/shared/docs/<publicId>`. Son dos direcciones para lo mismo a propósito — una para leer y otra
 * para consumir— y las dos salen del servidor en vez de componerse en la pantalla.
 */
export const DOC_PATH_PREFIX = "docs";

export const MAX_DOC_NAME = 120;
export const MAX_DOC_INTRO = 8_000;
export const MAX_DOC_BASE_URL = 300;
/** Cinco por proyecto. Cada uno es una URL pública viva, y más de cinco son sitios olvidados. */
export const MAX_DOC_SITES_PER_PROJECT = 5;

export const DOC_VISIBILITIES = ["public", "private"] as const;
export type DocVisibility = (typeof DOC_VISIBILITIES)[number];

export type DocSite = {
  id: string;
  projectId: string;
  name: string;
  /** El segmento opaco de la URL. Único en toda la instalación, no solo en el proyecto. */
  publicId: string;
  visibility: DocVisibility;
  /** SHA-256 de la clave. Nulo en un sitio público, que no tiene clave. */
  apiKeyHash: string | null;
  /** Los primeros y los últimos caracteres, para distinguir dos claves sin revelar ninguna. */
  apiKeyPreview: string;
  /** Contra qué se pegan los ejemplos de código de la página. Vacío no enseña ninguna. */
  baseUrl: string;
  /** Texto libre que sale arriba: para qué es esta API y qué hay que saber antes de llamarla. */
  intro: string;
  /** Si los cuerpos de ejemplo guardados salen en la página. Empieza apagado. */
  includeExamples: boolean;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
};

export type DocSiteInput = {
  name?: string;
  visibility?: DocVisibility;
  baseUrl?: string;
  intro?: string;
  includeExamples?: boolean;
  enabled?: boolean;
};

/** 128 bits en base64url: 22 caracteres que caben en una URL y no se teclean a mano. */
export function newDocPublicId(): string {
  return generateOpaqueToken(16);
}

/**
 * La URL base, como se guarda: sin la barra final.
 *
 * `https://api.example.com/` y `https://api.example.com` son la misma, y guardar las dos formas
 * daría `https://api.example.com//v1/pedidos` en la mitad de las páginas.
 */
export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function docSiteProblems(input: DocSiteInput, { requireVisibility = false } = {}): Problem[] {
  const problems: Problem[] = [];
  const problem = (field: string, detail: string) => problems.push({ field, detail });

  if (input.name !== undefined) {
    if (!input.name.trim()) problem("name", "Falta el nombre");
    else if (input.name.length > MAX_DOC_NAME) problem("name", `Como mucho ${MAX_DOC_NAME} caracteres`);
  }

  if (requireVisibility && input.visibility === undefined) {
    // Sin valor por defecto a propósito: publicar la API de un proyecto es una decisión, y una
    // decisión que se toma por omisión no se ha tomado.
    problem("visibility", "Di si la documentación es «public» o «private»");
  }
  if (input.visibility !== undefined && !DOC_VISIBILITIES.includes(input.visibility))
    problem("visibility", "Tiene que ser «public» o «private»");

  if (input.baseUrl !== undefined) {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    if (baseUrl.length > MAX_DOC_BASE_URL) problem("baseUrl", `Como mucho ${MAX_DOC_BASE_URL} caracteres`);
    else if (baseUrl && !/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
      // Ni una variable ni un host a secas: esta página no tiene entorno con el que resolver
      // `{{baseUrl}}`, así que una variable aquí publica un `curl` que no se puede pegar.
      problem("baseUrl", "Escribe una URL entera que empiece por http:// o https://, sin variables");
    }
  }

  if (input.intro !== undefined && input.intro.length > MAX_DOC_INTRO)
    problem("intro", `Como mucho ${MAX_DOC_INTRO} caracteres`);

  return problems;
}

/** Lo que se crea, más la clave en claro cuando es privado — que se devuelve una vez y nunca más. */
export type NewDocSite = { site: DocSite; apiKey: string | null };

export function blankDocSite(fields: {
  projectId: string;
  name: string;
  visibility: DocVisibility;
  baseUrl?: string;
  intro?: string;
  includeExamples?: boolean;
  now: Date;
  actorId: string;
}): NewDocSite {
  const apiKey = fields.visibility === "private" ? generateOpaqueToken(32) : null;
  return {
    apiKey,
    site: {
      id: randomUUID(),
      projectId: fields.projectId,
      name: fields.name,
      publicId: newDocPublicId(),
      visibility: fields.visibility,
      apiKeyHash: apiKey ? hashOpaqueToken(apiKey) : null,
      apiKeyPreview: apiKey ? tokenPreview(apiKey) : "",
      baseUrl: normalizeBaseUrl(fields.baseUrl ?? ""),
      intro: fields.intro?.trim() ?? "",
      // Apagado salvo que se diga: publicar la forma de la API es una cosa y publicar sus datos
      // es otra.
      includeExamples: fields.includeExamples ?? false,
      enabled: true,
      createdAt: fields.now,
      updatedAt: fields.now,
      createdBy: fields.actorId,
    },
  };
}

/** Una clave nueva para un sitio privado. La vieja deja de valer en el mismo momento. */
export function rotatedDocKey(site: DocSite, now: Date): { site: DocSite; apiKey: string } {
  const apiKey = generateOpaqueToken(32);
  return {
    apiKey,
    site: { ...site, apiKeyHash: hashOpaqueToken(apiKey), apiKeyPreview: tokenPreview(apiKey), updatedAt: now },
  };
}

/** Lo que sale por la API de gestión. Sin el hash: es lo único secreto que hay en la fila. */
export type DocSiteView = Omit<DocSite, "projectId" | "apiKeyHash" | "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};

export function viewDocSite(site: DocSite): DocSiteView {
  const { projectId: _projectId, apiKeyHash: _apiKeyHash, ...rest } = site;
  return { ...rest, createdAt: site.createdAt.toISOString(), updatedAt: site.updatedAt.toISOString() };
}
