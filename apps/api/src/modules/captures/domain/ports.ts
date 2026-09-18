import type { CaptureItem, CaptureSession, CaptureStopReason } from "./model";

export const CAPTURE_REPOSITORY = Symbol("CAPTURE_REPOSITORY");

/**
 * Las sesiones de captura y lo que grabaron.
 *
 * **Toda lectura lleva `projectId`**, como en los endpoints y en los canales: un id de sesión o de
 * petición que alguien adivine no alcanza la captura de otro proyecto, porque la consulta nunca
 * pregunta solo por el id.
 *
 * Las peticiones se añaden de una en una y no se reescriben nunca: la sesión lleva la cuenta, y una
 * captura de quinientas no puede volver a escribir las quinientas cada vez que llega una.
 */
export interface CaptureRepositoryPort {
  saveSession(session: CaptureSession): Promise<void>;
  findSession(projectId: string, id: string): Promise<CaptureSession | null>;
  /** Las más recientes primero. */
  listSessions(projectId: string, limit: number): Promise<CaptureSession[]>;
  /** Las `active` de **cualquier** proyecto: con alguna, el proxy de cada instancia escucha. */
  listActive(): Promise<CaptureSession[]>;
  removeSession(projectId: string, id: string): Promise<boolean>;
  /**
   * La sesión de un token, por su hash, **abierta o no**: el proxy de cualquier instancia pregunta
   * aquí, y una cerrada le sirve para decir «terminó» en vez de «no existe».
   */
  findSessionByTokenHash(tokenHash: string): Promise<CaptureSession | null>;
  /**
   * Cierra una sesión **si sigue abierta**, sin tocar nada más de la fila. Devuelve si la cerró.
   *
   * Condicional y no un `saveSession` de la fila leída: mientras tanto otra instancia puede haber
   * subido `itemCount`, y reescribir la fila entera lo bajaría.
   */
  stopSession(projectId: string, id: string, reason: CaptureStopReason, at: Date): Promise<boolean>;
  /** Cierra como `expired` las abiertas cuya hora ya pasó. Devuelve cuántas. */
  expireDue(now: Date): Promise<number>;
  /**
   * Añade una petición con el siguiente `seq`, **atómicamente**: sube `itemCount` solo si la sesión
   * sigue abierta y por debajo de `maxRequests`, y escribe la fila con ese número en la misma
   * transacción. Devuelve el `seq`, o `null` si la sesión ya no admite más.
   *
   * La transacción es lo que mantiene la lista en vivo en orden con varias instancias: el bloqueo
   * de la fila de la sesión hace que la 8 no se escriba antes de que la 7 esté escrita, y así el
   * cursor de la pantalla no se salta ninguna.
   */
  appendNext(item: Omit<CaptureItem, "seq">, maxRequests: number): Promise<number | null>;
  appendItem(item: CaptureItem): Promise<void>;
  /** En orden de llegada, las que vienen después de `afterSeq`. */
  listItems(projectId: string, sessionId: string, afterSeq: number, limit: number): Promise<CaptureItem[]>;
  findItems(projectId: string, sessionId: string, ids: string[]): Promise<CaptureItem[]>;
}

export const CAPTURE_AUTHORITY_REPOSITORY = Symbol("CAPTURE_AUTHORITY_REPOSITORY");

/** La CA de captura tal como se guarda: el certificado en claro, la clave **solo cifrada**. */
export type StoredCaptureAuthority = {
  certificatePem: string;
  /** La clave privada PKCS#8 cifrada con `SECRETS_KEY` (`v1.…`). Nunca hay otra forma de guardarla. */
  privateKeyCiphertext: string;
  createdAt: Date;
};

/**
 * La CA de la instalación: una fila, o ninguna.
 *
 * `insertIfAbsent` y no `save`: dos instancias que arrancan a la vez generan cada una la suya, y
 * solo una puede quedarse. La otra relee y usa la que ganó; si pudiera reescribirla, un dispositivo
 * que ya instaló la primera dejaría de confiar en lo que firma el proxy.
 */
export interface CaptureAuthorityRepositoryPort {
  find(): Promise<StoredCaptureAuthority | null>;
  insertIfAbsent(authority: StoredCaptureAuthority): Promise<void>;
}
