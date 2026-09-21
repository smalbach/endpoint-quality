/**
 * El turno de las corridas que no pueden ir dos a la vez en todo el despliegue.
 *
 * Una corrida de seguridad y una de rendimiento van de una en una: dos matrices contra el mismo
 * objetivo harían inútiles las heurísticas de tamaño y de límite de la primera, y dos cargas a la
 * vez medirían su propia contención y no la API. Las colas en memoria lo cumplían **por proceso**:
 * con N réplicas, N a la vez. Esto es la fila que comparten todas, en la base de datos, que es lo
 * único que comparten siempre.
 *
 * Una fila por corrida que espera o corre, con el orden en que se encoló (`seq`) y el último latido
 * de su instancia. Empezar es condicional —nadie corriendo y nadie vivo delante—, bajo un candado
 * por tipo, así que dos instancias que lo intentan a la vez no ganan las dos. Una instancia que
 * muere deja de latir y su fila, pasado `staleMs`, deja de contar y se borra: la fila sigue sola.
 */
export const EXECUTION_TURNS = Symbol("EXECUTION_TURNS");

/** Cada tipo es una fila aparte: una corrida de seguridad no espera a una de rendimiento. */
export type TurnKind = "security" | "performance" | "collection";

export interface ExecutionTurnStorePort {
  /** `runId` espera turno, a nombre de `holder`, detrás de lo ya encolado. Si ya estaba, nada cambia. */
  join(kind: TurnKind, runId: string, holder: string): Promise<void>;
  /**
   * Empieza `runId` si no corre nada de su tipo y no hay nadie vivo encolado antes. Antes borra las
   * filas cuyo latido tiene más de `staleMs`: son de una instancia que ya no está.
   */
  tryStart(kind: TurnKind, runId: string, holder: string, staleMs: number): Promise<boolean>;
  /** Sigo vivo: renueva el latido de todas las filas de `holder`. Devuelve de qué corridas. */
  heartbeat(holder: string): Promise<string[]>;
  /** Fuera de la fila: terminó, o la cancelaron antes de empezar. */
  leave(runId: string, holder: string): Promise<void>;
}

type TurnRow = {
  kind: TurnKind;
  runId: string;
  holder: string;
  seq: number;
  startedAt: number | null;
  heartbeatAt: number;
};

/**
 * La fila en memoria. Es la de las pruebas —dos aplicaciones de prueba comparten una, como dos
 * réplicas comparten Postgres— y la de un despliegue sin base compartida, que no existe fuera de
 * ellas. Todo es síncrono dentro de cada llamada, así que el candado lo da el propio hilo.
 */
export class InMemoryExecutionTurnStore implements ExecutionTurnStorePort {
  readonly rows = new Map<string, TurnRow>();
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async join(kind: TurnKind, runId: string, holder: string): Promise<void> {
    if (this.rows.has(runId)) return;
    this.rows.set(runId, { kind, runId, holder, seq: ++this.seq, startedAt: null, heartbeatAt: this.now() });
  }

  async tryStart(kind: TurnKind, runId: string, holder: string, staleMs: number): Promise<boolean> {
    const now = this.now();
    for (const [id, row] of this.rows) if (row.kind === kind && now - row.heartbeatAt > staleMs) this.rows.delete(id);
    const mine = this.rows.get(runId);
    if (!mine || mine.holder !== holder || mine.startedAt !== null) return false;
    for (const other of this.rows.values()) {
      if (other.kind !== kind || other.runId === runId) continue;
      if (other.startedAt !== null || other.seq < mine.seq) return false;
    }
    mine.startedAt = now;
    mine.heartbeatAt = now;
    return true;
  }

  async heartbeat(holder: string): Promise<string[]> {
    const now = this.now();
    const beaten: string[] = [];
    for (const row of this.rows.values())
      if (row.holder === holder) {
        row.heartbeatAt = now;
        beaten.push(row.runId);
      }
    return beaten;
  }

  async leave(runId: string, holder: string): Promise<void> {
    if (this.rows.get(runId)?.holder === holder) this.rows.delete(runId);
  }
}
