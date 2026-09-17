/**
 * Anotar una llamada que el mock acaba de contestar.
 *
 * Es un comando aparte y no una línea dentro de `AnswerMockQuery`, y eso es deliberado: la consulta
 * que decide qué se contesta **no escribe nada**, y es lo que permite servir un mock sin tocar la
 * base de datos más que para leer. La bitácora es una consecuencia de esa respuesta, no parte de
 * ella, y se dispara cuando la respuesta ya salió.
 *
 * ## Que no estorbe
 *
 * Todo aquí es de segunda clase respecto a contestar. La ruta del mock es `@Public()` y recibe
 * tráfico de verdad: un mock que se cayera porque su bitácora se cayó sería peor que un mock sin
 * bitácora, así que quien lo llama envuelve esto en un `try` y lo hace **después** de escribir la
 * respuesta. Aquí dentro no hay ninguna validación que pueda rechazar una fila: lo que llega ya lo
 * decidió `serveMock`.
 *
 * El recorte de retención va en la misma llamada. Es una consulta por el índice
 * `(mockServerId, at DESC)` y un borrado de lo que sobra, y va aquí y no en un barrido nocturno
 * porque el tope es por mock: quien llena la tabla es un front ajeno en bucle, y esperar a la noche
 * para recortar sería dejar que crezca todo el día.
 */
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { MOCK_CALL_HISTORY, mockCallOf } from "../../domain/mock-call";
import { MOCK_REPOSITORY, type MockRepositoryPort } from "../../domain/ports";
import type { MockOutcome } from "../../domain/serve-mock";

/**
 * Lo que se anota, y nada más que esto.
 *
 * El comando recibe el método, la ruta y **la respuesta ya decidida**. No recibe la petición: no
 * puede anotar una cabecera ni un cuerpo porque no los tiene, y eso es más fuerte que acordarse de
 * no escribirlos. Ver la cabecera de `mock-call.ts`.
 */
export class RecordMockCallCommand implements ICommand {
  constructor(
    readonly mockServerId: string,
    readonly method: string,
    readonly path: string,
    readonly outcome: MockOutcome,
    readonly durationMs: number,
  ) {}
}

@CommandHandler(RecordMockCallCommand)
export class RecordMockCallHandler implements ICommandHandler<RecordMockCallCommand, void> {
  constructor(
    @Inject(MOCK_REPOSITORY) private readonly mocks: MockRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: RecordMockCallCommand): Promise<void> {
    await this.mocks.saveCall(
      mockCallOf({
        mockServerId: command.mockServerId,
        method: command.method,
        path: command.path,
        outcome: command.outcome,
        at: this.clock.now(),
        durationMs: command.durationMs,
      }),
    );
    await this.mocks.trimCalls(command.mockServerId, MOCK_CALL_HISTORY);
  }
}
