/**
 * `/metrics`, **apagado mientras nadie ponga un token**.
 *
 * Esto no es una pantalla más: expone las rutas internas, el nombre del proceso, su memoria y su
 * carga. Publicado sin más en el puerto de la API sería un mapa del despliegue servido a quien
 * pase. Por eso:
 *
 * - **Sin `METRICS_TOKEN` no existe.** Un 404, no un 403: una instalación que no ha pedido esto no
 *   tiene por qué anunciar que podría tenerlo.
 * - **Con token, se exige como `Bearer`** y se compara en tiempo constante, como cualquier otra
 *   credencial opaca de este sistema.
 * - **Fuera del documento OpenAPI.** El contrato que publica este producto describe su API, y esto
 *   no lo es: es una puerta de operación.
 *
 * `@SkipThrottle` porque un raspado cada quince segundos es tráfico legítimo y constante, y el
 * límite global está pensado para personas. Y `@Public` porque el guardia global pide una sesión
 * de usuario, que es justo lo que un raspador no tiene: su credencial es esta.
 */
import { Controller, Get, Headers, Inject, Res } from "@nestjs/common";
import { ApiExcludeEndpoint } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import type { Response } from "express";

import { ENV, type Env } from "@/shared/config/env";
import { hashOpaqueToken, opaqueTokenMatches } from "@/shared/crypto/opaque-token";
import { NotFoundError, UnauthenticatedError } from "@/shared/errors/domain-error";
import { Public } from "@/modules/auth/infrastructure/guards/auth.guard";
import { METRICS, type MetricsPort } from "./metrics.port";

@Controller("metrics")
export class MetricsController {
  constructor(
    @Inject(METRICS) private readonly metrics: MetricsPort,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  @SkipThrottle()
  @ApiExcludeEndpoint()
  @Get()
  async scrape(
    @Headers("authorization") authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const expected = this.env.METRICS_TOKEN;
    if (!expected) throw new NotFoundError("Cannot GET /metrics");

    const header = authorization ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!opaqueTokenMatches(given, hashOpaqueToken(expected))) throw new UnauthenticatedError("Falta la credencial");

    const { body, contentType } = await this.metrics.render();
    response.type(contentType);
    return body;
  }
}
