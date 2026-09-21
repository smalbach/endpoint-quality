import type { MockCall } from "@/modules/mocks/domain/mock-call";
import type { MockServer } from "@/modules/mocks/domain/model";
import type { MockRepositoryPort } from "@/modules/mocks/domain/ports";
import { inLifecycleState, type LifecycleState } from "@/shared/lifecycle/lifecycle";

export class InMemoryMockRepository implements MockRepositoryPort {
  readonly rows = new Map<string, MockServer>();
  /** La bitácora. Las pruebas miran aquí dentro para comprobar **lo que no se guardó**. */
  readonly calls = new Map<string, MockCall>();

  async listByProject(projectId: string, state: LifecycleState = "active") {
    return [...this.rows.values()]
      .filter((row) => row.projectId === projectId && inLifecycleState(row, state))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async findById(projectId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.projectId === projectId ? row : null;
  }

  async findByPublicId(publicId: string) {
    return (
      [...this.rows.values()].find((row) => row.publicId === publicId && inLifecycleState(row, "active")) ?? null
    );
  }

  async save(mock: MockServer) {
    this.rows.set(mock.id, structuredClone(mock));
  }

  async remove(projectId: string, id: string) {
    const row = await this.findById(projectId, id);
    if (!row) return false;
    this.rows.delete(id);
    // Lo que en Postgres hace el `ON DELETE CASCADE`: la bitácora de un mock borrado se va con él.
    for (const [key, call] of this.calls) if (call.mockServerId === id) this.calls.delete(key);
    return true;
  }

  async saveCall(call: MockCall) {
    this.calls.set(call.id, structuredClone(call));
  }

  async listCalls(mockServerId: string, limit: number) {
    return this.mine(mockServerId).slice(0, limit);
  }

  async trimCalls(mockServerId: string, keep: number) {
    for (const extra of this.mine(mockServerId).slice(keep)) this.calls.delete(extra.id);
  }

  /**
   * Las de ese mock, de la más reciente a la más vieja, que es el único orden en que se leen.
   *
   * El `reverse()` antes de ordenar es lo que desempata: en las pruebas el reloj está parado, así
   * que dos llamadas seguidas tienen el mismo `at` y el orden lo decide quién llegó después. Sin
   * esto, «la última llamada» sería la primera la mitad de las veces.
   */
  private mine(mockServerId: string): MockCall[] {
    return [...this.calls.values()]
      .filter((call) => call.mockServerId === mockServerId)
      .reverse()
      .sort((a, b) => b.at.getTime() - a.at.getTime());
  }
}
