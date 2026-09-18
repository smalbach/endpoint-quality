import { Inject } from "@nestjs/common";
import {
  CommandHandler,
  QueryHandler,
  type ICommand,
  type ICommandHandler,
  type IQuery,
  type IQueryHandler,
} from "@nestjs/cqrs";
import type { ForkDiffView, ForkSyncOutcomeView } from "@eq/contracts";

import { ConflictError, InvalidInputError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { resolutionProblems, type Resolutions } from "../../domain/fork-merge";
import { ForkSync, SYNC_DIRECTIONS, type Comparison, type SyncDirection } from "../fork-sync";

export function assertDirection(value: string): SyncDirection {
  if (!(SYNC_DIRECTIONS as readonly string[]).includes(value))
    throw new InvalidInputError("Sentido desconocido", [{ field: "direction", detail: "pull o merge" }]);
  return value as SyncDirection;
}

export class GetForkDiffQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly direction: SyncDirection,
  ) {}
}

/** La comparación como la ve una pantalla: qué proyecto da, cuál recibe, y cada elemento que cambió. */
export function view(comparison: Comparison): ForkDiffView {
  return {
    direction: comparison.direction,
    token: comparison.token,
    version: comparison.fork.version,
    syncedAt: comparison.fork.syncedAt.toISOString(),
    source: { id: comparison.source.project.id, name: comparison.source.project.name },
    target: { id: comparison.target.project.id, name: comparison.target.project.name },
    entries: comparison.entries,
  };
}

@QueryHandler(GetForkDiffQuery)
export class GetForkDiffHandler implements IQueryHandler<GetForkDiffQuery, ForkDiffView> {
  constructor(private readonly sync: ForkSync) {}

  async execute(query: GetForkDiffQuery): Promise<ForkDiffView> {
    return view(await this.sync.compare(query.organizationId, query.projectId, query.direction));
  }
}

export class SyncForkCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly direction: SyncDirection,
    readonly token: string,
    readonly resolutions: Resolutions,
    readonly actorId: string,
  ) {}
}

/**
 * Traer cambios del original, o fusionarlos en él.
 *
 * Lo que se aplica es la comparación que se enseñó: la huella que manda quien pulsa tiene que ser la
 * de ahora, o es un 409. Entre la vista y el clic alguien pudo guardar un flujo en cualquiera de los
 * dos lados, y aplicar unas decisiones tomadas sobre otra foto es decidir por esa persona.
 *
 * El destino tiene que admitir escrituras: un proyecto archivado no se toca ni desde aquí. El permiso
 * es el de escribir en el proyecto —`editor` de la organización, que es lo que pide cualquier otra
 * escritura en él—; al fusionar, el proyecto donde se escribe es el original.
 */
@CommandHandler(SyncForkCommand)
export class SyncForkHandler implements ICommandHandler<SyncForkCommand, ForkSyncOutcomeView> {
  constructor(
    private readonly sync: ForkSync,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: SyncForkCommand): Promise<ForkSyncOutcomeView> {
    const comparison = await this.sync.compare(command.organizationId, command.projectId, command.direction);
    const { plan, outcome } = checkedPlan(this.sync, comparison, command, this.clock.now());
    await this.sync.apply(plan);
    return outcome;
  }
}

/**
 * Lo que se comprueba antes de construir un plan, en un solo sitio: fusionar directamente y fusionar
 * una solicitud son la misma operación, y tienen que rechazar lo mismo del mismo modo. Lo único que
 * se comprueba después, dentro de la transacción, es la versión de la bifurcación.
 */
export function checkedPlan(
  sync: ForkSync,
  comparison: Comparison,
  input: { token: string; resolutions: Resolutions; actorId: string },
  now: Date,
) {
  if (comparison.target.project.archivedAt)
    throw new ConflictError(`«${comparison.target.project.name}» está archivado`, "project-archived");
  if (input.token !== comparison.token)
    throw new ConflictError(
      "Alguno de los dos proyectos cambió desde que se hizo la comparación: vuelve a cargarla",
      "fork-diff-stale",
    );
  const problems = resolutionProblems(comparison.entries, input.resolutions);
  if (problems.length) throw new InvalidInputError("Faltan decisiones o sobran", problems, "fork-unresolved");
  return sync.plan(comparison, input.resolutions, input.actorId, now);
}
