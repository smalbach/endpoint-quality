import type { CaptureItem, CaptureSession } from "@/modules/captures/domain/model";
import type { CaptureRepositoryPort } from "@/modules/captures/domain/ports";

export class InMemoryCaptureRepository implements CaptureRepositoryPort {
  readonly sessions = new Map<string, CaptureSession>();
  /** Lo grabado. Las pruebas miran aquí dentro para comprobar **lo que no se guardó en claro**. */
  readonly items = new Map<string, CaptureItem>();

  async saveSession(session: CaptureSession) {
    this.sessions.set(session.id, structuredClone(session));
  }

  async findSession(projectId: string, id: string) {
    const row = this.sessions.get(id);
    return row && row.projectId === projectId ? structuredClone(row) : null;
  }

  async listSessions(projectId: string, limit: number) {
    return [...this.sessions.values()]
      .filter((row) => row.projectId === projectId)
      .reverse()
      .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())
      .slice(0, limit)
      .map((row) => structuredClone(row));
  }

  async listActive() {
    return [...this.sessions.values()].filter((row) => row.status === "active").map((row) => structuredClone(row));
  }

  async removeSession(projectId: string, id: string) {
    const row = this.sessions.get(id);
    if (!row || row.projectId !== projectId) return false;
    this.sessions.delete(id);
    // Lo que en Postgres hace el `ON DELETE CASCADE`.
    for (const [key, item] of this.items) if (item.sessionId === id) this.items.delete(key);
    return true;
  }

  async appendItem(item: CaptureItem) {
    this.items.set(item.id, structuredClone(item));
  }

  async listItems(projectId: string, sessionId: string, afterSeq: number, limit: number) {
    return this.of(projectId, sessionId)
      .filter((item) => item.seq > afterSeq)
      .slice(0, limit);
  }

  async findItems(projectId: string, sessionId: string, ids: string[]) {
    const wanted = new Set(ids);
    return this.of(projectId, sessionId).filter((item) => wanted.has(item.id));
  }

  private of(projectId: string, sessionId: string): CaptureItem[] {
    return [...this.items.values()]
      .filter((item) => item.projectId === projectId && item.sessionId === sessionId)
      .sort((left, right) => left.seq - right.seq)
      .map((item) => structuredClone(item));
  }
}
