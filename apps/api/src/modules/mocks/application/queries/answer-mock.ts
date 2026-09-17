/**
 * Contestar una petición que llega a la URL de un mock.
 *
 * Es una consulta y no un comando aunque sea un `POST`: el mock **no escribe nada**. Ni guarda lo
 * que le piden, ni toca la API de verdad, ni cambia un ejemplo. Un mock que tuviera estado dejaría
 * de ser reproducible, que es lo único que se le pide.
 *
 * La bitácora de llamadas no rompe eso, y por eso no está aquí: es un comando aparte
 * (`RecordMockCallCommand`) que se dispara cuando la respuesta ya salió, con lo que esta consulta
 * decidió. Lo que se anota no cambia lo que el mock contesta la próxima vez.
 *
 * Aquí viven las dos cosas que el motor puro no puede saber: si el `publicId` existe, y si la clave
 * que trae la petición es la del mock. Todo lo demás —encontrar la ruta, elegir el ejemplo, limpiar
 * las cabeceras— es `serve-mock.ts` y se prueba sin base de datos.
 */
import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";

import { opaqueTokenMatches } from "@/shared/crypto/opaque-token";
import {
  ENDPOINT_REPOSITORY,
  EXAMPLE_REPOSITORY,
  type EndpointRepositoryPort,
  type ExampleRepositoryPort,
} from "@/modules/endpoints/domain/ports";
import { delayFor, type MockDelay } from "../../domain/model";
import { MOCK_REPOSITORY, type MockRepositoryPort } from "../../domain/ports";
import { serveMock, type MockOutcome, type MockRequest } from "../../domain/serve-mock";

/** La cabecera de un mock privado. `x-api-key` es lo que usa Postman, y es lo que ya saben todos. */
export const MOCK_KEY_HEADER = "x-api-key";

export type MockAnswer = {
  outcome: MockOutcome;
  /** Milisegundos a esperar antes de contestar. Cero cuando el mock no simula latencia. */
  delayMs: number;
  /**
   * De qué mock era la URL, para que quien sirve pueda anotar la llamada en su bitácora.
   *
   * Nulo cuando el `publicId` no corresponde a ninguno, y entonces no hay nada que anotar: una fila
   * de una llamada a un mock que no existe no tiene dónde colgarse, y contar los intentos contra
   * URLs inventadas sería guardar el rastreo de un tercero.
   */
  mockServerId: string | null;
};

export class AnswerMockQuery implements IQuery {
  constructor(
    readonly publicId: string,
    readonly request: MockRequest,
  ) {}
}

const problem = (
  status: number,
  code: string,
  title: string,
  detail: string,
  mockServerId: string | null,
): MockAnswer => ({
  delayMs: 0,
  outcome: { kind: "problem", status, code, title, detail },
  mockServerId,
});

@QueryHandler(AnswerMockQuery)
export class AnswerMockHandler implements IQueryHandler<AnswerMockQuery, MockAnswer> {
  constructor(
    @Inject(MOCK_REPOSITORY) private readonly mocks: MockRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(EXAMPLE_REPOSITORY) private readonly examples: ExampleRepositoryPort,
  ) {}

  async execute(query: AnswerMockQuery): Promise<MockAnswer> {
    const mock = await this.mocks.findByPublicId(query.publicId);
    // Un `publicId` que no existe y uno que existió y se borró dan lo mismo, y tienen que darlo:
    // distinguirlos convertiría esta ruta en un oráculo para adivinar URLs de mocks.
    if (!mock)
      return problem(
        404,
        "mock-not-found",
        "Ese mock no existe",
        "La URL no corresponde a ningún mock de este servidor.",
        null,
      );

    if (!mock.enabled)
      return problem(
        503,
        "mock-disabled",
        "Este mock está apagado",
        "Existe y su configuración sigue ahí, pero está apagado. Enciéndelo desde el proyecto para que vuelva a contestar.",
        // Anotada igual: «apunté el front y me da 503» es exactamente lo que la bitácora resuelve.
        mock.id,
      );

    if (mock.visibility === "private") {
      const key = query.request.headers[MOCK_KEY_HEADER]?.trim();
      // `opaqueTokenMatches` compara en tiempo constante, y el hash nulo no puede abrir nada.
      if (!key || !mock.apiKeyHash || !opaqueTokenMatches(key, mock.apiKeyHash))
        return problem(
          401,
          "mock-key-invalid",
          "Falta la clave de este mock",
          `Este mock es privado: manda la clave en la cabecera «${MOCK_KEY_HEADER}».`,
          // El código del «no», nunca la clave que llegó: de eso trata la cabecera de `mock-call.ts`.
          mock.id,
        );
    }

    const [endpoints, examples] = await Promise.all([
      this.endpoints.listAll(mock.projectId),
      this.examples.listByProject(mock.projectId),
    ]);
    const byEndpoint = new Map<string, typeof examples>();
    for (const example of examples) {
      byEndpoint.set(example.endpointId, [...(byEndpoint.get(example.endpointId) ?? []), example]);
    }

    return {
      outcome: serveMock(endpoints, (endpointId) => byEndpoint.get(endpointId) ?? [], query.request),
      delayMs: delayFor(mock.delay as MockDelay),
      mockServerId: mock.id,
    };
  }
}
