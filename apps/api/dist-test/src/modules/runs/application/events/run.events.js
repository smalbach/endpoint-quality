"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunFinishedEvent = exports.RunCaseFinishedEvent = exports.RunStartedEvent = void 0;
/** Published as the run walks. They feed the SSE stream and, later, whatever wants to react to a
 * red matrix — a webhook, a CI exit code, a notification. */
class RunStartedEvent {
    projectId;
    runId;
    cases;
    constructor(projectId, runId, cases) {
        this.projectId = projectId;
        this.runId = runId;
        this.cases = cases;
    }
}
exports.RunStartedEvent = RunStartedEvent;
class RunCaseFinishedEvent {
    projectId;
    runId;
    runCase;
    totals;
    constructor(projectId, runId, runCase, totals) {
        this.projectId = projectId;
        this.runId = runId;
        this.runCase = runCase;
        this.totals = totals;
    }
}
exports.RunCaseFinishedEvent = RunCaseFinishedEvent;
class RunFinishedEvent {
    projectId;
    runId;
    status;
    totals;
    constructor(projectId, runId, status, totals) {
        this.projectId = projectId;
        this.runId = runId;
        this.status = status;
        this.totals = totals;
    }
}
exports.RunFinishedEvent = RunFinishedEvent;
//# sourceMappingURL=run.events.js.map