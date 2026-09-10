"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const swagger_1 = require("@nestjs/swagger");
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const helmet_1 = __importDefault(require("helmet"));
const app_module_1 = require("./app.module");
const env_1 = require("./shared/config/env");
const common_2 = require("@nestjs/common");
const body_limits_1 = require("./shared/http/body-limits");
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule, { bufferLogs: true });
    const env = app.get(env_1.ENV);
    app.use((0, helmet_1.default)());
    app.use((0, cookie_parser_1.default)());
    // Express defaults to 100 KB, which is smaller than a real OpenAPI document: Digital
    // Catalog's is 118 KB. Raised to the figure the DTO validates against so the two agree.
    app.useBodyParser("json", { limit: body_limits_1.MAX_JSON_BODY });
    app.enableCors({ origin: env.CORS_ORIGINS.split(",").map((origin) => origin.trim()), credentials: true });
    app.useGlobalPipes(new common_1.ValidationPipe({
        whitelist: true,
        // A body with fields the DTO does not declare is rejected rather than trimmed: silently
        // dropping `role: "owner"` from a request that tried to send it hides an attempt.
        forbidNonWhitelisted: true,
        transform: true,
        // 422 and not 400, because that is what "syntactically fine, semantically wrong" means —
        // and it is what this product asserts of every API it points at.
        errorHttpStatusCode: common_2.HttpStatus.UNPROCESSABLE_ENTITY,
    }));
    // The product that verifies contracts publishes its own.
    const document = swagger_1.SwaggerModule.createDocument(app, new swagger_1.DocumentBuilder().setTitle("Endpoint Quality API").setVersion("0.1.0").addBearerAuth().build());
    swagger_1.SwaggerModule.setup("docs", app, document, { jsonDocumentUrl: "openapi.json" });
    await app.listen(env.PORT);
    new common_1.Logger("bootstrap").log(`API escuchando en http://localhost:${env.PORT} · OpenAPI en /openapi.json`);
}
void bootstrap();
//# sourceMappingURL=main.js.map