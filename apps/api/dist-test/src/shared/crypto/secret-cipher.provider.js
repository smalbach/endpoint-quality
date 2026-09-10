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
exports.SecretCipherProvider = void 0;
const common_1 = require("@nestjs/common");
const env_1 = require("../config/env");
const secret_cipher_1 = require("./secret-cipher");
/**
 * The cipher, keyed from the environment.
 *
 * **It refuses to work without `SECRETS_KEY` rather than falling back to a fixed key.** A
 * default key is the same as no encryption at all, and worse, because the ciphertext in the
 * database looks like it means something. Storing a credential is the first operation that needs
 * it, so the failure lands on the person configuring the deployment rather than months later on
 * whoever has to explain the breach.
 */
let SecretCipherProvider = class SecretCipherProvider {
    env;
    cipher = null;
    constructor(env) {
        this.env = env;
    }
    get delegate() {
        if (!this.env.SECRETS_KEY) {
            throw new Error("SECRETS_KEY no está configurada: no se pueden guardar credenciales de destino cifradas");
        }
        this.cipher ??= new secret_cipher_1.AesGcmSecretCipher(this.env.SECRETS_KEY);
        return this.cipher;
    }
    encrypt(plain) {
        return this.delegate.encrypt(plain);
    }
    decrypt(payload) {
        return this.delegate.decrypt(payload);
    }
};
exports.SecretCipherProvider = SecretCipherProvider;
exports.SecretCipherProvider = SecretCipherProvider = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(env_1.ENV)),
    __metadata("design:paramtypes", [Object])
], SecretCipherProvider);
//# sourceMappingURL=secret-cipher.provider.js.map