"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpecVersionImportedEvent = void 0;
class SpecVersionImportedEvent {
    projectId;
    specVersionId;
    hash;
    operationCount;
    at;
    constructor(projectId, specVersionId, hash, operationCount, at) {
        this.projectId = projectId;
        this.specVersionId = specVersionId;
        this.hash = hash;
        this.operationCount = operationCount;
        this.at = at;
    }
}
exports.SpecVersionImportedEvent = SpecVersionImportedEvent;
//# sourceMappingURL=spec-version-imported.event.js.map