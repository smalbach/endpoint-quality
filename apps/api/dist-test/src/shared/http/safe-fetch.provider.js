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
exports.ConfiguredSafeFetch = void 0;
const common_1 = require("@nestjs/common");
const env_1 = require("../config/env");
const safe_fetch_1 = require("./safe-fetch");
/**
 * The guard, wired to the deployment's policy.
 *
 * A provider rather than a bare function so a test can substitute it — and, more importantly, so
 * there is exactly one place where the policy is read. A second call site that built its own
 * policy object would be a second chance to leave `allowPrivateTargets` on.
 */
let ConfiguredSafeFetch = class ConfiguredSafeFetch {
    env;
    constructor(env) {
        this.env = env;
    }
    get policy() {
        return {
            allowPrivateTargets: this.env.ALLOW_PRIVATE_TARGETS,
            maxRedirects: this.env.MAX_REDIRECTS,
            timeoutMs: this.env.REQUEST_TIMEOUT_MS,
            maxResponseBytes: this.env.MAX_RESPONSE_BYTES,
        };
    }
    get(url, options = {}) {
        return (0, safe_fetch_1.safeFetch)(url, this.policy, options);
    }
    request(url, options) {
        return (0, safe_fetch_1.safeFetch)(url, this.policy, options);
    }
};
exports.ConfiguredSafeFetch = ConfiguredSafeFetch;
exports.ConfiguredSafeFetch = ConfiguredSafeFetch = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(env_1.ENV)),
    __metadata("design:paramtypes", [Object])
], ConfiguredSafeFetch);
//# sourceMappingURL=safe-fetch.provider.js.map