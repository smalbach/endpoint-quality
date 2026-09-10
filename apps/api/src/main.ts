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

  // The product that verifies contracts publishes its own.
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle("Endpoint Quality API").setVersion("0.1.0").addBearerAuth().build(),
  );
  SwaggerModule.setup("docs", app, document, { jsonDocumentUrl: "openapi.json" });

  await app.listen(env.PORT);
  new Logger("bootstrap").log(`API escuchando en http://localhost:${env.PORT} · OpenAPI en /openapi.json`);
}

void bootstrap();
