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
exports.TypeOrmInvitationRepository = exports.TypeOrmMembershipRepository = exports.TypeOrmOrganizationRepository = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const entities_1 = require("../../../../shared/database/entities");
let TypeOrmOrganizationRepository = class TypeOrmOrganizationRepository {
    repository;
    constructor(repository) {
        this.repository = repository;
    }
    async findById(id) {
        const row = await this.repository.findOne({ where: { id } });
        return row ? { ...row } : null;
    }
    async findBySlug(slug) {
        const row = await this.repository.findOne({ where: { slug } });
        return row ? { ...row } : null;
    }
    async save(organization) {
        await this.repository.save(organization);
    }
};
exports.TypeOrmOrganizationRepository = TypeOrmOrganizationRepository;
exports.TypeOrmOrganizationRepository = TypeOrmOrganizationRepository = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(entities_1.OrganizationEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], TypeOrmOrganizationRepository);
let TypeOrmMembershipRepository = class TypeOrmMembershipRepository {
    repository;
    constructor(repository) {
        this.repository = repository;
    }
    async find(organizationId, userId) {
        const row = await this.repository.findOne({ where: { organizationId, userId } });
        return row ? toMembership(row) : null;
    }
    async listForUser(userId) {
        return (await this.repository.find({ where: { userId }, order: { createdAt: "ASC" } })).map(toMembership);
    }
    async listForOrganization(organizationId) {
        return (await this.repository.find({ where: { organizationId }, order: { createdAt: "ASC" } })).map(toMembership);
    }
    async save(membership) {
        await this.repository.save(membership);
    }
    async remove(organizationId, userId) {
        await this.repository.delete({ organizationId, userId });
    }
};
exports.TypeOrmMembershipRepository = TypeOrmMembershipRepository;
exports.TypeOrmMembershipRepository = TypeOrmMembershipRepository = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(entities_1.MembershipEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], TypeOrmMembershipRepository);
let TypeOrmInvitationRepository = class TypeOrmInvitationRepository {
    repository;
    constructor(repository) {
        this.repository = repository;
    }
    async findByHash(hash) {
        const row = await this.repository.findOne({ where: { tokenHash: hash } });
        return row ? toInvitation(row) : null;
    }
    async findPending(organizationId, email) {
        const rows = await this.repository.find({ where: { organizationId, email: email.toLowerCase() } });
        const pending = rows.find((row) => !row.acceptedAt && !row.revokedAt);
        return pending ? toInvitation(pending) : null;
    }
    async listForOrganization(organizationId) {
        return (await this.repository.find({ where: { organizationId }, order: { createdAt: "DESC" } })).map(toInvitation);
    }
    async save(invitation) {
        await this.repository.save({ ...invitation, email: invitation.email.toLowerCase() });
    }
};
exports.TypeOrmInvitationRepository = TypeOrmInvitationRepository;
exports.TypeOrmInvitationRepository = TypeOrmInvitationRepository = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(entities_1.InvitationEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], TypeOrmInvitationRepository);
const toMembership = (row) => ({ ...row, role: row.role });
const toInvitation = (row) => ({ ...row, role: row.role });
//# sourceMappingURL=typeorm-repositories.js.map