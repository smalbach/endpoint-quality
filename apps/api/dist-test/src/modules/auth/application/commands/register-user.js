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
exports.RegisterUserHandler = exports.RegisterUserCommand = void 0;
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const clock_port_1 = require("../../../../shared/clock/clock.port");
const password_hasher_1 = require("../../../../shared/crypto/password-hasher");
const create_organization_1 = require("../../../iam/application/commands/create-organization");
const model_1 = require("../../domain/model");
const ports_1 = require("../../domain/ports");
const user_registered_event_1 = require("../events/user-registered.event");
class RegisterUserCommand {
    email;
    password;
    name;
    organizationName;
    constructor(email, password, name, 
    /** The name of the organization created alongside the account. Absent means one named after
     * the person, which is what a first sign-up almost always wants. */
    organizationName) {
        this.email = email;
        this.password = password;
        this.name = name;
        this.organizationName = organizationName;
    }
}
exports.RegisterUserCommand = RegisterUserCommand;
/**
 * Creates the account **and** the organization that owns everything it will go on to create.
 *
 * The organization is not optional and not deferred: every project, environment and run hangs
 * off one, so a user without an organization is an account that cannot do anything, and a UI
 * that has to handle that state is a state that exists only because registration skipped a step.
 *
 * It is created by dispatching `CreateOrganizationCommand` and awaiting it, rather than by
 * publishing an event the `iam` module reacts to. The event would be the more fashionable
 * choice and the wrong one here: `EventBus.publish` does not await its handlers, so the client
 * could log in and ask for its organizations before the handler that creates one has run.
 * Ordering matters, so this is a command.
 */
let RegisterUserHandler = class RegisterUserHandler {
    users;
    passwords;
    clock;
    commandBus;
    eventBus;
    constructor(users, passwords, clock, commandBus, eventBus) {
        this.users = users;
        this.passwords = passwords;
        this.clock = clock;
        this.commandBus = commandBus;
        this.eventBus = eventBus;
    }
    async execute(command) {
        const email = (0, model_1.normalizeEmail)(command.email);
        if (!email.includes("@"))
            throw new domain_error_1.InvalidInputError("El correo no es válido", [{ field: "email", detail: "Debe ser una dirección de correo" }]);
        // Length is the only password rule enforced. Composition rules ("one uppercase, one symbol")
        // measurably push people towards `Password1!` and are not in NIST 800-63B any more; length
        // is what actually buys entropy.
        if (command.password.length < 12) {
            throw new domain_error_1.InvalidInputError("La contraseña es demasiado corta", [{ field: "password", detail: "Debe tener al menos 12 caracteres" }]);
        }
        if (await this.users.findByEmail(email)) {
            // This does leak that the address is registered, and it is the right trade here: the
            // alternative is silently not creating an account and telling the person it worked. The
            // enumeration surface that matters — login — does not leak, and that is where it counts.
            throw new domain_error_1.ConflictError("Ese correo ya tiene una cuenta", "email-taken");
        }
        const now = this.clock.now();
        const user = {
            id: (0, node_crypto_1.randomUUID)(),
            email,
            name: command.name.trim() || email.split("@")[0],
            passwordDigest: await this.passwords.hash(command.password),
            status: "active",
            createdAt: now,
        };
        await this.users.save(user);
        const { organizationId } = await this.commandBus.execute(new create_organization_1.CreateOrganizationCommand(command.organizationName?.trim() || `${user.name}`, user.id));
        this.eventBus.publish(new user_registered_event_1.UserRegisteredEvent(user.id, user.email, organizationId, now));
        return { userId: user.id, organizationId };
    }
};
exports.RegisterUserHandler = RegisterUserHandler;
exports.RegisterUserHandler = RegisterUserHandler = __decorate([
    (0, cqrs_1.CommandHandler)(RegisterUserCommand),
    __param(0, (0, common_1.Inject)(ports_1.USER_REPOSITORY)),
    __param(1, (0, common_1.Inject)(password_hasher_1.PASSWORD_HASHER)),
    __param(2, (0, common_1.Inject)(clock_port_1.CLOCK)),
    __metadata("design:paramtypes", [Object, Object, Object, cqrs_1.CommandBus,
        cqrs_1.EventBus])
], RegisterUserHandler);
//# sourceMappingURL=register-user.js.map