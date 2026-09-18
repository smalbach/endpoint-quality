import { Controller, HttpCode, Param, Post, Put, Req } from "@nestjs/common";
import { CommandBus } from "@nestjs/cqrs";
import { Throttle } from "@nestjs/throttler";

import { Public } from "@/modules/auth/infrastructure/guards/auth.guard";
import { DeliverFlowHookCommand } from "../application/commands/deliver-flow-hook";
import { HOOK_RATE_LIMIT } from "../domain/flow-hooks";

type InboundCall = { headers: Record<string, string | string[] | undefined>; body?: unknown };

/**
 * La URL que reparte un nodo webhook mientras espera, a la que llama un proveedor de pagos o un
 * trabajo que avisa al terminar.
 *
 * Pública, y la única ruta pública que **escribe**: lo que acepta se convierte en una respuesta dentro
 * de la corrida de alguien. El token de la ruta es la credencial. El cuerpo llega por el lector propio
 * del webhook (1 MB, cualquier tipo, montado en este prefijo antes del JSON global), así que aquí
 * llegan bytes y nada se ha parseado con los 8 MB de las rutas con sesión.
 *
 * 202 y sin cuerpo: la llamada se tomó, y lo que el flujo haga con ella es cosa de la corrida.
 */
@Controller("hooks/flows")
export class FlowHooksController {
  constructor(private readonly commandBus: CommandBus) {}

  @Post(":token")
  @Public()
  @HttpCode(202)
  @Throttle({ default: { limit: HOOK_RATE_LIMIT, ttl: 60_000 } })
  async post(@Param("token") token: string, @Req() request: InboundCall): Promise<void> {
    await this.commandBus.execute(new DeliverFlowHookCommand(token, "POST", request.headers, request.body));
  }

  @Put(":token")
  @Public()
  @HttpCode(202)
  @Throttle({ default: { limit: HOOK_RATE_LIMIT, ttl: 60_000 } })
  async put(@Param("token") token: string, @Req() request: InboundCall): Promise<void> {
    await this.commandBus.execute(new DeliverFlowHookCommand(token, "PUT", request.headers, request.body));
  }
}
