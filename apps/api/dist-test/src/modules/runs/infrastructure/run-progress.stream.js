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
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunFinishedProjector = exports.RunCaseProjector = exports.RunStartedProjector = exports.RunProgressStream = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const rxjs_1 = require("rxjs");
const run_events_1 = require("../application/events/run.events");
/**
 * The bridge from domain events to whoever is watching.
 *
 * A single hot `Subject` filtered per run, rather than one stream per subscriber: a run publishes
 * an event per case, and building an observable chain per follower would multiply that by the
 * number of open tabs.
 *
 * It is **in-process**. With `QUEUE_DRIVER=redis` and more than one API instance, a follower
 * connected to instance B sees nothing from a run executing on instance A — the polling fallback
 * covers that today, and a Redis pub/sub relay is the fix when multi-instance becomes real.
 */
let RunProgressStream = class RunProgressStream {
    events = new rxjs_1.Subject();
    publish(event) {
        this.events.next(event);
    }
    forRun(runId) {
        return this.events.asObservable().pipe((0, rxjs_1.filter)((event) => event.runId === runId));
    }
};
exports.RunProgressStream = RunProgressStream;
exports.RunProgressStream = RunProgressStream = __decorate([
    (0, common_1.Injectable)()
], RunProgressStream);
let RunStartedProjector = class RunStartedProjector {
    stream;
    constructor(stream) {
        this.stream = stream;
    }
    handle(event) {
        this.stream.publish({ runId: event.runId, type: "started", payload: { cases: event.cases } });
    }
};
exports.RunStartedProjector = RunStartedProjector;
exports.RunStartedProjector = RunStartedProjector = __decorate([
    (0, cqrs_1.EventsHandler)(run_events_1.RunStartedEvent),
    __metadata("design:paramtypes", [RunProgressStream])
], RunStartedProjector);
let RunCaseProjector = class RunCaseProjector {
    stream;
    constructor(stream) {
        this.stream = stream;
    }
    handle(event) {
        this.stream.publish({ runId: event.runId, type: "case", payload: { case: event.runCase, totals: event.totals } });
    }
};
exports.RunCaseProjector = RunCaseProjector;
exports.RunCaseProjector = RunCaseProjector = __decorate([
    (0, cqrs_1.EventsHandler)(run_events_1.RunCaseFinishedEvent),
    __metadata("design:paramtypes", [RunProgressStream])
], RunCaseProjector);
let RunFinishedProjector = class RunFinishedProjector {
    stream;
    constructor(stream) {
        this.stream = stream;
    }
    handle(event) {
        this.stream.publish({ runId: event.runId, type: "finished", payload: { status: event.status, totals: event.totals } });
    }
};
exports.RunFinishedProjector = RunFinishedProjector;
exports.RunFinishedProjector = RunFinishedProjector = __decorate([
    (0, cqrs_1.EventsHandler)(run_events_1.RunFinishedEvent),
    __metadata("design:paramtypes", [RunProgressStream])
], RunFinishedProjector);
//# sourceMappingURL=run-progress.stream.js.map