import "reflect-metadata";
import { Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";

import { AppModule } from "./app.module";
import { ENV, type Env } from "./shared/config/env";
import { HttpStatus } from "@nestjs/common";
import { MAX_JSON_BODY } from "./shared/http/body-limits";
import { describeErrors } from "./shared/openapi/describe-errors";
import { describeBodies } from "./shared/openapi/describe-bodies";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const env = app.get<Env>(ENV);

  app.use(helmet());
  app.use(cookieParser());
  // Express defaults to 100 KB, which is smaller than a real OpenAPI document: Digital
  // Catalog's is 118 KB. Raised to the figure the DTO validates against so the two agree.
  app.useBodyParser("json", { limit: MAX_JSON_BODY });
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
  new Logger("bootstrap").log(`API escuchando en http://localhost:${env.PORT} · OpenAPI en /openapi.json`);
}

void bootstrap();
