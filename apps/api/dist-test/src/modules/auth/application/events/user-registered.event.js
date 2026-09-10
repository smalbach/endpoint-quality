"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserRegisteredEvent = void 0;
/** Published after the account and its organization exist. Nothing in the request path depends
 * on a subscriber having run — it is there for audit and, later, for the welcome mail. */
class UserRegisteredEvent {
    userId;
    email;
    organizationId;
    at;
    constructor(userId, email, organizationId, at) {
        this.userId = userId;
        this.email = email;
        this.organizationId = organizationId;
        this.at = at;
    }
}
exports.UserRegisteredEvent = UserRegisteredEvent;
//# sourceMappingURL=user-registered.event.js.map