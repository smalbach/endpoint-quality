import type { DiffEntry } from "./fork-merge";

/**
 * Una solicitud de fusión: «quiero llevar lo de esta bifurcación al original», dicho a quien cuida
 * el original antes de hacerlo.
 *
 * Fusionar directamente sigue existiendo —quien puede escribir en el original no necesita pedirse
 * permiso a sí mismo—; esto es la conversación de antes: un título, una descripción, comentarios,
 * aprobaciones y la decisión. La fusión que la cierra es **la misma** que la directa, con la misma
 * comparación a tres bandas y los mismos conflictos, calculada en el momento de fusionar.
 *
 * `diff` es la comparación tal como estaba al crearla: lo que la persona pidió llevar. No es lo que
 * se aplica —entre crearla y fusionarla los dos proyectos siguen vivos—, y por eso se guarda aparte
 * y se enseña aparte: «lo que se pidió» y «lo que se aplicaría ahora».
 */
export const MERGE_REQUEST_STATUSES = ["open", "approved", "merged", "declined", "closed"] as const;
export type MergeRequestStatus = (typeof MERGE_REQUEST_STATUSES)[number];

/** Las que aún esperan una decisión. Una bifurcación tiene como mucho una así. */
export const PENDING_STATUSES: readonly MergeRequestStatus[] = ["open", "approved"];

export type ForkMergeRequest = {
  id: string;
  organizationId: string;
  forkProjectId: string;
  parentProjectId: string;
  title: string;
  description: string;
  status: MergeRequestStatus;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  /** La comparación al crearla, sin secretos: sale de las mismas fotos que la foto común. */
  diff: DiffEntry[];
  /** La versión de la bifurcación cuando se creó, para poder decir «desde entonces se sincronizó». */
  diffVersion: number;
  /** Quien la cerró —fusionando, rechazando o retirándola— y cuándo. */
  decidedBy: string | null;
  decidedAt: Date | null;
  /** La versión de la bifurcación que dejó la fusión. */
  mergedVersion: number | null;
};

/**
 * Lo que pasa en una solicitud, en orden: el hilo que se lee en la pantalla.
 *
 * Un comentario y una decisión van en la misma lista porque se leen juntos —«aprobado: falta el
 * entorno de pre» es las dos cosas—, y una decisión sin texto es una línea más del hilo.
 */
export const MERGE_REQUEST_EVENT_KINDS = ["comment", "approved", "declined", "merged", "closed"] as const;
export type MergeRequestEventKind = (typeof MERGE_REQUEST_EVENT_KINDS)[number];

export type MergeRequestEvent = {
  id: string;
  requestId: string;
  organizationId: string;
  authorId: string;
  kind: MergeRequestEventKind;
  body: string;
  createdAt: Date;
};

export type MergeRequestAction = "approve" | "decline" | "close" | "merge";

/** Lo que una acción deja, o por qué no se puede: `state` es un 409 y `author` un 403. */
export type Transition =
  | { ok: true; status: MergeRequestStatus; event: MergeRequestEventKind; decides: boolean }
  | { ok: false; reason: "state" | "author"; detail: string };

/**
 * Las reglas de las decisiones, puras.
 *
 * - **Aprobar** no la cierra: dice «por mí, sí», y otra persona puede aprobar también. Quien la
 *   creó no se aprueba a sí mismo —una aprobación propia no le dice nada a nadie—.
 * - **Rechazar** es de quien revisa, y **retirar** es de quien la creó: los dos la cierran sin
 *   tocar nada, pero dicen cosas distintas en el hilo.
 * - **Fusionar** la puede cualquiera que pueda escribir en el original, también quien la creó: el
 *   permiso de escribir allí ya es suyo, y hacerle esperar una aprobación que el producto no exige
 *   sería inventar una regla.
 *
 * Solo sobre una solicitud pendiente: una fusionada, rechazada o retirada ya se decidió.
 */
export function transition(
  request: Pick<ForkMergeRequest, "status" | "createdBy">,
  action: MergeRequestAction,
  actorId: string,
): Transition {
  if (!PENDING_STATUSES.includes(request.status))
    return { ok: false, reason: "state", detail: `La solicitud ya está ${STATUS_LABEL[request.status]}` };
  const own = request.createdBy === actorId;
  switch (action) {
    case "approve":
      if (own) return { ok: false, reason: "author", detail: "No puedes aprobar tu propia solicitud" };
      return { ok: true, status: "approved", event: "approved", decides: false };
    case "decline":
      if (own) return { ok: false, reason: "author", detail: "Tu propia solicitud se retira, no se rechaza" };
      return { ok: true, status: "declined", event: "declined", decides: true };
    case "close":
      if (!own) return { ok: false, reason: "author", detail: "Solo quien la creó puede retirarla" };
      return { ok: true, status: "closed", event: "closed", decides: true };
    case "merge":
      return { ok: true, status: "merged", event: "merged", decides: true };
  }
}

export const STATUS_LABEL: Record<MergeRequestStatus, string> = {
  open: "abierta",
  approved: "aprobada",
  merged: "fusionada",
  declined: "rechazada",
  closed: "retirada",
};

export type MergeRequestInputProblem = { field: string; detail: string };

export function mergeRequestProblems(input: { title?: string; description?: string }): MergeRequestInputProblem[] {
  const problems: MergeRequestInputProblem[] = [];
  const title = input.title?.trim() ?? "";
  if (!title) problems.push({ field: "title", detail: "Escribe un título" });
  else if (title.length > 200) problems.push({ field: "title", detail: "Como mucho 200 caracteres" });
  if ((input.description ?? "").length > 10_000)
    problems.push({ field: "description", detail: "Como mucho 10 000 caracteres" });
  return problems;
}
