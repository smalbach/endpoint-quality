import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";

import { AppModule } from "./app.module";
import { ENV, type Env } from "./shared/config/env";
import { CLOCK, type ClockPort } from "./shared/clock/clock.port";
import { LOGGER, type LoggerPort } from "./shared/logging/logger.port";
import { NestLoggerBridge } from "./shared/logging/nest-logger.bridge";
import { traceMiddleware } from "./shared/logging/trace.middleware";
import { HttpStatus } from "@nestjs/common";
import { MAX_JSON_BODY } from "./shared/http/body-limits";
import { describeErrors } from "./shared/openapi/describe-errors";
import { describeBodies } from "./shared/openapi/describe-bodies";
import { MOCK_PATH_PREFIX } from "./modules/mocks/domain/model";
import { mockCors } from "./modules/mocks/presentation/mock-cors";
import { FLOW_HOOK_PATH, flowHookBodyParser } from "./shared/http/hook-body";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const env = app.get<Env>(ENV);
  const logger = app.get<LoggerPort>(LOGGER);

  // Lo que ya escribe Nest —el arranque, el barrido de retención, los avisos de un monitor— sale
  // por el mismo registro que el resto: una línea JSON con su nivel y su traza, y un solo
  // `LOG_LEVEL` que vale para todo. `bufferLogs` de arriba es lo que hace que ni las líneas del
  // arranque se queden en el formato anterior.
  app.useLogger(new NestLoggerBridge(logger));

  // Antes que nada, helmet incluido: una petición rechazada por un middleware que ni llega a Nest
  // también tiene que poder citarse por su identificador.
  app.use(traceMiddleware(app.get<ClockPort>(CLOCK)));
  app.use(helmet());
  app.use(cookieParser());
  // La ruta pública del webhook lee su propio cuerpo —cualquier tipo, 1 MB— antes del JSON de abajo.
  app.use(FLOW_HOOK_PATH, flowHookBodyParser());
  // Express defaults to 100 KB, which is smaller than a real OpenAPI document: Digital
  // Catalog's is 118 KB. Raised to the figure the DTO validates against so the two agree.
  app.useBodyParser("json", { limit: MAX_JSON_BODY });
  // Antes del CORS global, y solo bajo `/mock`: el de Nest contesta el preflight él mismo con la
  // lista de orígenes de la API, que es lo contrario de lo que un mock necesita. Ver `mock-cors.ts`.
  app.use(`/${MOCK_PATH_PREFIX}`, mockCors);
  app.enableCors({ origin: env.CORS_ORIGINS.split(",").map((origin) => origin.trim()), credentials: true });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // A body with fields the DTO does not declare is rejected rather than trimmed: silently
      // dropping `role: "owner"` from a request that tried to send it hides an attempt.
      forbidNonWhitelisted: true,
      transform: true,
      // 422 and not 400, because that is what "syntactically fine, semantically wrong" means —
      // and it is what this product asserts of every API it points at.
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    }),
  );

  // The product that verifies contracts publishes its own — **including what it answers when
  // things go wrong**. Nest's document describes what the handlers return, which is the happy
  // path; the errors are added from the shape of the route, because that is where the guards
  // decide them. A contract that promises less than the service does is the exact fault this
  // product looks for elsewhere.
  const document = describeBodies(
    describeErrors(
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
          .setTitle("Endpoint Quality API")
          .setDescription("Verificación de contratos HTTP. Todos los errores son RFC 9457 (application/problem+json).")
          .setVersion("0.1.0")
          .addBearerAuth()
          .build(),
      ),
    ),
  );
  SwaggerModule.setup("docs", app, document, { jsonDocumentUrl: "openapi.json" });

  await app.listen(env.PORT);
  logger.log("info", "API escuchando", {
    url: `http://localhost:${env.PORT}`,
    openapi: `http://localhost:${env.PORT}/openapi.json`,
    logLevel: env.LOG_LEVEL,
  });
}

void bootstrap();
