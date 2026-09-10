"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FixedClock = exports.SystemClock = exports.CLOCK = void 0;
/** Time as a dependency. A handler that calls `new Date()` cannot be tested for expiry without
 * either waiting or mocking globals; one that asks the clock can. */
exports.CLOCK = Symbol("CLOCK");
class SystemClock {
    now() {
        return new Date();
    }
}
exports.SystemClock = SystemClock;
/** A clock the tests move by hand. */
class FixedClock {
    current;
    constructor(current) {
        this.current = current;
    }
    now() {
        return new Date(this.current);
    }
    advance(ms) {
        this.current = new Date(this.current.getTime() + ms);
    }
    set(date) {
        this.current = new Date(date);
    }
}
exports.FixedClock = FixedClock;
//# sourceMappingURL=clock.port.js.map