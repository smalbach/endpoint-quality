import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { NotFoundError } from "@/shared/errors/domain-error";
import { INSTANCE_BUS, type InstanceBusPort } from "@/shared/bus/instance-bus";
import {
  FLOW_HOOK_REPOSITORY,
  FLOW_HOOK_TOKEN,
  FLOW_HOOK_TOPIC,
  hashFlowHookToken,
  readHookPayload,
  type FlowHookMethod,
  type FlowHookRepositoryPort,
} from "../../domain/flow-hooks";

export class DeliverFlowHookCommand implements ICommand {
  constructor(
    readonly token: string,
    readonly method: FlowHookMethod,
    readonly headers: Record<string, string | string[] | undefined>,
    /** Lo que dejó el lector del cuerpo del webhook: un Buffer, o nada en una llamada vacía. */
    readonly body: unknown,
  ) {}
}

/**
 * Un sistema externo llamando a un nodo webhook que espera.
 *
 * Sin sesión y sin proyecto en la ruta: el token es toda la credencial. Cualquier forma de no ser
 * aceptada —mal formado, desconocido, caducado, usado, otro verbo— es el mismo 404 con el mismo
 * cuerpo, así que la ruta no sirve para saber qué tokens existieron. Ver `domain/flow-hooks.ts`.
 *
 * Lo que llegó se tapa **aquí**, antes de guardarlo: la tabla, el bus y la fila del paso solo ven la
 * versión tapada. Aceptada la llamada, se avisa por el bus a todas las instancias; la que tiene la
 * corrida se despierta, y las demás no tienen nada que hacer con el aviso.
 */
@CommandHandler(DeliverFlowHookCommand)
export class DeliverFlowHookHandler implements ICommandHandler<DeliverFlowHookCommand, void> {
  constructor(
    @Inject(FLOW_HOOK_REPOSITORY) private readonly hooks: FlowHookRepositoryPort,
    @Inject(INSTANCE_BUS) private readonly bus: InstanceBusPort,
  ) {}

  async execute(command: DeliverFlowHookCommand): Promise<void> {
    // Reloj de pared, como la caducidad que se escribió al abrir la espera.
    const now = new Date();
    const taken = FLOW_HOOK_TOKEN.test(command.token)
      ? await this.hooks.deliver(
          hashFlowHookToken(command.token),
          command.method,
          readHookPayload(command.method, command.headers, command.body, now),
          now,
        )
      : null;
    if (!taken) throw new NotFoundError("Este webhook no existe o ya no espera ninguna llamada", "flow-hook-not-found");
    // Solo el id: lo que llegó se lee de la tabla, y el token no viaja.
    this.bus.publish(FLOW_HOOK_TOPIC, { hookId: taken.id });
  }
}
