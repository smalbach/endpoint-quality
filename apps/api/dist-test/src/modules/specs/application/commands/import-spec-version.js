"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImportSpecVersionHandler = exports.ImportSpecVersionCommand = void 0;
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const spec_import_1 = require("@eq/spec-import");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const clock_port_1 = require("../../../../shared/clock/clock.port");
const safe_fetch_1 = require("../../../../shared/http/safe-fetch");
const ports_1 = require("../../../projects/domain/ports");
const update_project_1 = require("../../../projects/application/commands/update-project");
const ports_2 = require("../../domain/ports");
const spec_version_imported_event_1 = require("../events/spec-version-imported.event");
class ImportSpecVersionCommand {
    organizationId;
    projectId;
    source;
    importedBy;
    activate;
    constructor(organizationId, projectId, source, importedBy, 
    /** Whether the imported version becomes the one runs use. False imports it for comparison
     * only, which is what a drift check does. */
    activate) {
        this.organizationId = organizationId;
        this.projectId = projectId;
        this.source = source;
        this.importedBy = importedBy;
        this.activate = activate;
    }
}
exports.ImportSpecVersionCommand = ImportSpecVersionCommand;
/**
 * Reads a contract into the project, as a snapshot.
 *
 * This is the command that retires `scripts/gen_dashboard_endpoints.py`. There, the operation
 * table was generated into a TypeScript file in another repository and compiled into the
 * dashboard's bundle; when the contract moved, the copy went stale in silence and the tool
 * reported green against a spec that no longer existed.
 *
 * Three decisions worth knowing:
 *
 * - **The raw document is stored, not only the operations.** Schema validation during a run
 *   reads the document itself, and re-fetching it mid-run would mean asserting against a
 *   contract that can change while the matrix is walking it.
 * - **The same bytes resolve to the same version.** A re-import of an unchanged document returns
 *   the existing row instead of piling up identical snapshots, which is what lets a drift check
 *   run on a schedule without growing the table.
 * - **A URL is fetched through the SSRF guard.** This is the first place the server requests an
 *   address a customer typed, and "importa el contrato desde esta URL" is otherwise a form field
 *   that reads the cloud metadata endpoint.
 */
let ImportSpecVersionHandler = class ImportSpecVersionHandler {
    projects;
    specs;
    http;
    clock;
    eventBus;
    constructor(projects, specs, http, clock, eventBus) {
        this.projects = projects;
        this.specs = specs;
        this.http = http;
        this.clock = clock;
        this.eventBus = eventBus;
    }
    async execute(command) {
        const project = await (0, update_project_1.ownedProject)(this.projects, command.organizationId, command.projectId);
        const raw = await this.read(command.source);
        if (!raw.trim())
            throw new domain_error_1.InvalidInputError("El documento está vacío", [{ field: "source", detail: "No se recibió contenido" }]);
        const hash = (0, spec_import_1.fingerprint)(raw);
        const existing = await this.specs.findVersionByHash(project.id, hash);
        if (existing) {
            // Identical bytes. Activation is still honoured, because "import this and use it" is a
            // reasonable thing to ask about a version that happens to already be on file.
            const activated = command.activate && project.activeSpecVersionId !== existing.id;
            if (activated)
                await this.projects.save({ ...project, activeSpecVersionId: existing.id });
            return { specVersionId: existing.id, hash, operationCount: existing.operationCount, problems: existing.problems, unchanged: true, activated };
        }
        const parsed = (0, spec_import_1.importSpec)(raw);
        const errors = parsed.problems.filter((problem) => problem.severity === "error");
        if (errors.length) {
            // Errors stop the import; warnings do not. A document with one unnamed operation is worth
            // importing — the other forty-five are usable — but one that is not OpenAPI 3 at all would
            // produce an operation table that silently means nothing.
            throw new domain_error_1.InvalidInputError("El documento no se pudo importar", errors.map((problem) => ({ field: problem.pointer, detail: problem.message })), "spec-invalid");
        }
        const now = this.clock.now();
        const specVersionId = (0, node_crypto_1.randomUUID)();
        const sourceId = await this.recordSource(project.id, command.source, now);
        await this.specs.saveVersion({
            id: specVersionId,
            projectId: project.id,
            sourceId,
            hash,
            raw,
            format: raw.trim().startsWith("{") ? "json" : "yaml",
            openapiVersion: parsed.openapiVersion,
            title: parsed.title,
            contractVersion: parsed.version,
            operationCount: parsed.operations.length,
            problems: parsed.problems,
            importedBy: command.importedBy,
            importedAt: now,
        }, 
        // Spread first, then the row fields: `operation.id` is the contract's operationId and
        // must survive, while `rowId` is this table's key.
        parsed.operations.map((operation, position) => ({ ...operation, rowId: (0, node_crypto_1.randomUUID)(), specVersionId, position })));
        // The first successful import activates itself whatever the flag says: a project whose only
        // contract is not the active one has nothing to run, and no operator ever means that.
        const activate = command.activate || project.activeSpecVersionId === null;
        if (activate)
            await this.projects.save({ ...project, activeSpecVersionId: specVersionId });
        this.eventBus.publish(new spec_version_imported_event_1.SpecVersionImportedEvent(project.id, specVersionId, hash, parsed.operations.length, now));
        return { specVersionId, hash, operationCount: parsed.operations.length, problems: parsed.problems, unchanged: false, activated: activate };
    }
    async read(source) {
        if (source.kind !== "url")
            return source.raw;
        const response = await this.http.get(source.url, { headers: source.headers });
        if (response.status >= 400) {
            throw new domain_error_1.InvalidInputError(`El contrato respondió ${response.status}`, [{ field: "url", detail: `${source.url} devolvió ${response.status}` }], "spec-unreachable");
        }
        return response.body;
    }
    async recordSource(projectId, source, now) {
        const id = (0, node_crypto_1.randomUUID)();
        await this.specs.saveSource({
            id,
            projectId,
            kind: source.kind,
            location: source.kind === "url" ? source.url : source.kind === "upload" ? source.filename : "",
            // Headers for a contract behind auth are a credential. P3 encrypts them with the same
            // cipher as the target credentials; until there is a key to do it with, they are not
            // persisted at all rather than persisted in the clear.
            headersCiphertext: null,
            createdAt: now,
        });
        return id;
    }
};
exports.ImportSpecVersionHandler = ImportSpecVersionHandler;
exports.ImportSpecVersionHandler = ImportSpecVersionHandler = __decorate([
    (0, cqrs_1.CommandHandler)(ImportSpecVersionCommand),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.SPEC_REPOSITORY)),
    __param(2, (0, common_1.Inject)(safe_fetch_1.SAFE_FETCH)),
    __param(3, (0, common_1.Inject)(clock_port_1.CLOCK)),
    __metadata("design:paramtypes", [Object, Object, Object, Object, cqrs_1.EventBus])
], ImportSpecVersionHandler);
//# sourceMappingURL=import-spec-version.js.map