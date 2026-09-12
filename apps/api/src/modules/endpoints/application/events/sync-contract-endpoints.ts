import { Inject, Logger } from "@nestjs/common";
import { EventsHandler, type IEventHandler } from "@nestjs/cqrs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { SPEC_REPOSITORY, type SpecRepositoryPort } from "@/modules/specs/domain/ports";
import { SpecVersionActivatedEvent } from "@/modules/specs/application/events/spec-version-activated.event";
import { endpointKey, type Endpoint } from "../../domain/model";
import { ENDPOINT_REPOSITORY, type EndpointRepositoryPort } from "../../domain/ports";
import { draftFromOperation } from "../../domain/import-endpoints";
import { takenKeys } from "../commands/manage-endpoints";
import { materialize } from "../commands/import-endpoints";

/**
 * The contract the project now runs against, reflected in its endpoints.
 *
 * Additive only. An operation with no endpoint gets one (`origin: "contract"`); an endpoint that
 * already is that method and path — written by hand, imported from Postman — is linked to the
 * operation and otherwise left alone. **Nothing is removed or rewritten when the contract drops an
 * operation**: the list shows it as «fuera del contrato», and somebody decides.
 */
@EventsHandler(SpecVersionActivatedEvent)
export class SyncContractEndpointsHandler implements IEventHandler<SpecVersionActivatedEvent> {
  private readonly logger = new Logger("ContractEndpoints");

  constructor(
    @Inject(PROJECT_REPOSITORY) readonly projects: ProjectRepositoryPort,
    @Inject(SPEC_REPOSITORY) readonly specs: SpecRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) readonly endpoints: EndpointRepositoryPort,
    @Inject(CLOCK) readonly clock: ClockPort,
  ) {}

  async handle(event: SpecVersionActivatedEvent): Promise<void> {
    try {
      await syncContractEndpoints(this, event);
    } catch (error) {
      // An event handler that throws takes nothing down with it but its own work, so the failure is
      // logged here: the import already succeeded, and the next activation tries again.
      this.logger.error(`No se pudieron sincronizar los endpoints del proyecto ${event.projectId}`, error as Error);
    }
  }
}

export async function syncContractEndpoints(
  deps: {
    projects: ProjectRepositoryPort;
    specs: SpecRepositoryPort;
    endpoints: EndpointRepositoryPort;
    clock: ClockPort;
  },
  event: SpecVersionActivatedEvent,
): Promise<{ created: number; linked: number }> {
  const project = await deps.projects.findById(event.projectId);
  if (!project || project.activeSpecVersionId !== event.specVersionId) return { created: 0, linked: 0 };

  const operations = await deps.specs.listOperations(event.specVersionId);
  const taken = await takenKeys(deps.endpoints, project.id);
  const now = deps.clock.now();
  const actorId = event.actorId || project.createdBy;

  const linked: Endpoint[] = [];
  const drafts = [];
  const seen = new Set<string>();
  for (const operation of operations) {
    const draft = draftFromOperation(operation, true);
    const key = endpointKey(draft.method, draft.path);
    if (seen.has(key)) continue;
    seen.add(key);
    const existing = taken.get(key);
    if (!existing) drafts.push(draft);
    else if (existing.operationId !== operation.id) linked.push({ ...existing, operationId: operation.id });
  }

  const created = await materialize(deps.endpoints, project.id, drafts, "contract", now, actorId);
  await deps.endpoints.saveMany([...created, ...linked]);
  return { created: created.length, linked: linked.length };
}
