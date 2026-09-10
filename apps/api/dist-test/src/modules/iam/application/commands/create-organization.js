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
exports.CreateOrganizationHandler = exports.CreateOrganizationCommand = void 0;
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const clock_port_1 = require("../../../../shared/clock/clock.port");
const model_1 = require("../../domain/model");
const ports_1 = require("../../domain/ports");
class CreateOrganizationCommand {
    name;
    ownerId;
    constructor(name, ownerId) {
        this.name = name;
        this.ownerId = ownerId;
    }
}
exports.CreateOrganizationCommand = CreateOrganizationCommand;
/**
 * Creates an organization and makes its creator the owner, in that order and never separately.
 *
 * An organization with no owner cannot be given one — only an owner can promote anybody — so the
 * two writes are one operation. Persisting the organization and failing before the membership
 * leaves a row nobody in the system can reach or delete.
 */
let CreateOrganizationHandler = class CreateOrganizationHandler {
    organizations;
    memberships;
    clock;
    constructor(organizations, memberships, clock) {
        this.organizations = organizations;
        this.memberships = memberships;
        this.clock = clock;
    }
    async execute(command) {
        const now = this.clock.now();
        const slug = await this.freeSlug((0, model_1.slugify)(command.name));
        const organizationId = (0, node_crypto_1.randomUUID)();
        await this.organizations.save({ id: organizationId, name: command.name.trim(), slug, createdAt: now });
        await this.memberships.save({ organizationId, userId: command.ownerId, role: "owner", createdAt: now });
        return { organizationId, slug };
    }
    /** Two organizations can share a name; they cannot share a slug, because the slug is what
     * appears in a URL. The suffix is numeric and sequential rather than random so the second
     * "Acme" is `acme-2` and not `acme-f3a9`. */
    async freeSlug(base) {
        if (!(await this.organizations.findBySlug(base)))
            return base;
        for (let suffix = 2; suffix < 1000; suffix += 1) {
            const candidate = `${base}-${suffix}`;
            if (!(await this.organizations.findBySlug(candidate)))
                return candidate;
        }
        return `${base}-${(0, node_crypto_1.randomUUID)().slice(0, 8)}`;
    }
};
exports.CreateOrganizationHandler = CreateOrganizationHandler;
exports.CreateOrganizationHandler = CreateOrganizationHandler = __decorate([
    (0, cqrs_1.CommandHandler)(CreateOrganizationCommand),
    __param(0, (0, common_1.Inject)(ports_1.ORGANIZATION_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_1.MEMBERSHIP_REPOSITORY)),
    __param(2, (0, common_1.Inject)(clock_port_1.CLOCK)),
    __metadata("design:paramtypes", [Object, Object, Object])
], CreateOrganizationHandler);
//# sourceMappingURL=create-organization.js.map