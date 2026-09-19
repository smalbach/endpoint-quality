/**
 * La aplicación entera, arrancada como la arranca `main.ts`: el `AppModule` de verdad, con cada
 * módulo, sus `forwardRef`, sus fábricas y sus `onApplicationBootstrap`, contra un Postgres de verdad.
 *
 * El arnés de `test/support/test-app.ts` registra los proveedores en un módulo plano y por eso no
 * puede ver un fallo de cableado: un símbolo que un módulo no exporta, un ciclo sin `forwardRef`, un
 * trabajador que no empieza a escuchar. Aquí sí se vería, porque se arranca lo mismo que en producción.
 *
 * La base es un esquema privado (`openIsolatedDb`): la aplicación se conecta con ese `search_path`, así
 * que lo que escribe cae ahí y nunca en `public`. Nada escucha en un puerto fijo: el proxy de captura va
 * apagado (sin `CAPTURE_PROXY_PORT`), igual que la retención y el turno de monitores, y la API escucha en
 * un puerto libre de `127.0.0.1`.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { HttpStatus, ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import request from "supertest";

import { AppModule } from "@/app.module";
import { ENV, loadEnv, type Env } from "@/shared/config/env";
import { MAX_JSON_BODY } from "@/shared/http/body-limits";
import { FLOW_HOOK_PATH, flowHookBodyParser } from "@/shared/http/hook-body";
import { describeErrors } from "@/shared/openapi/describe-errors";
import { describeBodies } from "@/shared/openapi/describe-bodies";
import { RUN_QUEUE } from "@/modules/runs/domain/ports";
import { InMemoryRunQueue } from "@/modules/runs/infrastructure/queue/in-memory-queue";
import { SECURITY_AI } from "@/modules/security-runs/domain/ai";
import { FallbackSecurityAi } from "@/modules/security-runs/infrastructure/security-ai";
import { MAILER, LogMailer } from "@/shared/mail/mailer";
import { INSTANCE_BUS } from "@/shared/bus/instance-bus";
import { InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";
import { dbSkip, DATABASE_URL, openIsolatedDb, type IsolatedDb } from "../support/isolated-db";

let db: IsolatedDb;
let app: INestApplication;
let env: Env;

/** La URL de la base con el esquema privado como `search_path`, que `pg` lee del parámetro `options`. */
function urlFor(schema: string): string {
  const url = new URL(DATABASE_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

describe("la aplicación completa arranca", { skip: dbSkip }, () => {
  before(async () => {
    db = await openIsolatedDb();
    env = loadEnv({
      NODE_ENV: "test",
      DATABASE_URL: urlFor(db.schema),
      JWT_ACCESS_SECRET: "a".repeat(48),
      JWT_REFRESH_SECRET: "b".repeat(48),
      SECRETS_KEY: Buffer.alloc(32, 7).toString("base64"),
      // Nada de relojes de fondo ni de puertos fijos: cada uno de estos apagados es lo documentado.
      RETENTION_SWEEP_HOURS: "0",
      MONITOR_TICK_SECONDS: "0",
      QUEUE_DRIVER: "memory",
      MAIL_DRIVER: "log",
      SECURITY_AI_DRIVER: "off",
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ENV)
      .useValue(env)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    // Como `main.ts`, lo que afecta a lo que aquí se pide.
    app.use(FLOW_HOOK_PATH, flowHookBodyParser());
    (app as INestApplication & { useBodyParser: (type: string, options: object) => void }).useBodyParser("json", {
      limit: MAX_JSON_BODY,
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      }),
    );
    await app.listen(0, "127.0.0.1");
  });

  after(async () => {
    if (app) {
      (app.getHttpServer() as { closeAllConnections(): void }).closeAllConnections();
      await app.close();
    }
    await db?.drop();
  });

  const api = () => request(app.getHttpServer());

  test("las fábricas eligen los adaptadores de un despliegue de una instancia", () => {
    assert.ok(app.get(RUN_QUEUE) instanceof InMemoryRunQueue);
    assert.ok(app.get(SECURITY_AI) instanceof FallbackSecurityAi);
    assert.ok(app.get(MAILER) instanceof LogMailer);
    assert.ok(app.get(INSTANCE_BUS) instanceof InMemoryInstanceBus);
  });

  test("/health consulta la base y dice que está arriba", async () => {
    const response = await api().get("/health").expect(200);
    assert.equal(response.body.status, "ok");
    assert.equal(response.body.checks.database.status, "up");
  });

  test("una ruta protegida sin credenciales es un 401 en Problem Details", async () => {
    const response = await api().get("/auth/me").expect(401);
    assert.match(response.headers["content-type"], /application\/problem\+json/);
    assert.equal(response.body.status, 401);
    assert.equal(response.body.instance, "/auth/me");
  });

  test("registrarse escribe en el esquema privado y la sesión abre las rutas protegidas", async () => {
    const email = "arranque@example.com";
    const password = "Una-contraseña-larga-1";
    const registered = await api().post("/auth/register").send({ email, password, name: "Arranque" });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const session = await api().post("/auth/login").send({ email, password });
    assert.equal(session.status, 200, JSON.stringify(session.body));
    const token = session.body.accessToken as string;
    assert.ok(token, "el inicio de sesión no devolvió un token de acceso");

    const rows: { email: string }[] = await db.dataSource.query(`SELECT email FROM users WHERE email = $1`, [email]);
    assert.deepEqual(
      rows.map((row) => row.email),
      [email],
    );

    const me = await api().get("/auth/me").set("Authorization", `Bearer ${token}`).expect(200);
    assert.equal(me.body.email, email);
  });

  test("un cuerpo que no supera la validación es un 422 con el campo nombrado", async () => {
    const response = await api().post("/auth/login").send({ email: "no-es-un-correo", password: "x" }).expect(422);
    assert.ok(
      (response.body.errors as { field: string }[]).some((error) => error.field === "email"),
      JSON.stringify(response.body),
    );
  });

  test("el contrato de la aplicación arrancada describe cuerpos y errores", () => {
    const document: OpenAPIObject = describeBodies(
      describeErrors(
        SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("Endpoint Quality API").addBearerAuth().build()),
      ),
    );
    const register = document.paths["/auth/register"]?.post;
    assert.ok(register, "falta POST /auth/register");
    assert.ok(register.responses["422"], "el registro no declara su 422");
    const schema = document.components?.schemas?.RegisterDto as { required?: string[] } | undefined;
    assert.deepEqual(schema?.required?.sort(), ["email", "name", "password"]);
    assert.ok(document.paths["/health"], "falta /health");
  });
});
