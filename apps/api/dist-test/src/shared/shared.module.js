"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SharedModule = void 0;
const common_1 = require("@nestjs/common");
const clock_port_1 = require("./clock/clock.port");
/**
 * The cross-cutting providers every module needs and none owns.
 *
 * `@Global()` because time is not a dependency of any one module: a handler in `iam` and one in
 * `runs` both ask the clock, and requiring each feature module to re-provide it means the day
 * somebody forgets, the container fails at boot with a message about a symbol rather than about
 * a missing import.
 *
 * That is not hypothetical — it is exactly how this file came to exist. `CLOCK` was registered in
 * `AppModule`, which is not global, so every handler outside it failed to resolve. The in-memory
 * test harness registers its providers in one flat module, so the suite could not see it: the
 * first thing that did was starting the real process.
 */
let SharedModule = class SharedModule {
};
exports.SharedModule = SharedModule;
exports.SharedModule = SharedModule = __decorate([
    (0, common_1.Global)(),
    (0, common_1.Module)({
        providers: [{ provide: clock_port_1.CLOCK, useClass: clock_port_1.SystemClock }],
        exports: [clock_port_1.CLOCK],
    })
], SharedModule);
//# sourceMappingURL=shared.module.js.map