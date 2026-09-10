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
exports.CreateProjectHandler = exports.CreateProjectCommand = void 0;
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const clock_port_1 = require("../../../../shared/clock/clock.port");
const model_1 = require("../../domain/model");
const ports_1 = require("../../domain/ports");
class CreateProjectCommand {
    organizationId;
    name;
    description;
    createdBy;
    constructor(organizationId, name, description, createdBy) {
        this.organizationId = organizationId;
        this.name = name;
        this.description = description;
        this.createdBy = createdBy;
    }
}
exports.CreateProjectCommand = CreateProjectCommand;
let CreateProjectHandler = class CreateProjectHandler {
    projects;
    clock;
    constructor(projects, clock) {
        this.projects = projects;
        this.clock = clock;
    }
    async execute(command) {
        const project = {
            id: (0, node_crypto_1.randomUUID)(),
            organizationId: command.organizationId,
            name: command.name.trim(),
            slug: await this.freeSlug(command.organizationId, (0, model_1.slugifyProject)(command.name)),
            description: command.description.trim(),
            createdBy: command.createdBy,
            createdAt: this.clock.now(),
            archivedAt: null,
            // No contract yet. The project exists first and the spec is imported into it, because
            // importing is a step that can fail — against an unreachable URL, or a document that does
            // not parse — and losing the project along with the failed import helps nobody.
            activeSpecVersionId: null,
        };
        await this.projects.save(project);
        return { projectId: project.id, slug: project.slug };
    }
    /** Uniqueness is per organization. The numeric suffix is sequential rather than random so the
     * second "Catalog" is `catalog-2` and not `catalog-8f21`. */
    async freeSlug(organizationId, base) {
        if (!(await this.projects.findBySlug(organizationId, base)))
            return base;
        for (let suffix = 2; suffix < 1000; suffix += 1) {
            const candidate = `${base}-${suffix}`;
            if (!(await this.projects.findBySlug(organizationId, candidate)))
                return candidate;
        }
        return `${base}-${(0, node_crypto_1.randomUUID)().slice(0, 8)}`;
    }
};
exports.CreateProjectHandler = CreateProjectHandler;
exports.CreateProjectHandler = CreateProjectHandler = __decorate([
    (0, cqrs_1.CommandHandler)(CreateProjectCommand),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(clock_port_1.CLOCK)),
    __metadata("design:paramtypes", [Object, Object])
], CreateProjectHandler);
//# sourceMappingURL=create-project.js.map