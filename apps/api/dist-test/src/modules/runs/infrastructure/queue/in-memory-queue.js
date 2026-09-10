"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var InMemoryRunQueue_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryRunQueue = void 0;
const common_1 = require("@nestjs/common");
/**
 * The queue that needs no infrastructure.
 *
 * This is what keeps "ejecutable en local" honest: `pnpm dev`, a Postgres, and runs work. It
 * processes **one run at a time**, in order, in this process — which is a real limitation and
 * the right one for a single operator, because two matrices hitting the same target at once
 * would make every latency measurement meaningless.
 *
 * A run in flight dies with the process. That is the trade the Redis adapter exists to remove,
 * and the reason `QUEUE_DRIVER` is a deployment decision rather than a default.
 */
let InMemoryRunQueue = InMemoryRunQueue_1 = class InMemoryRunQueue {
    logger = new common_1.Logger(InMemoryRunQueue_1.name);
    pending = [];
    cancelled = new Set();
    handler = null;
    draining = false;
    async enqueue(runId) {
        this.pending.push(runId);
        // Not awaited: the HTTP request that started the run answers 202 immediately, which is what
        // makes closing the browser harmless.
        void this.drain();
    }
    process(handler) {
        this.handler = handler;
        void this.drain();
    }
    async cancel(runId) {
        this.cancelled.add(runId);
    }
    async isCancelled(runId) {
        return this.cancelled.has(runId);
    }
    async drain() {
        if (this.draining || !this.handler)
            return;
        this.draining = true;
        try {
            while (this.pending.length > 0) {
                const runId = this.pending.shift();
                try {
                    await this.handler(runId);
                }
                catch (error) {
                    // Swallowed on purpose: one run that throws must not stop the queue, and the handler
                    // has already recorded the failure against its own run.
                    this.logger.error(`La corrida ${runId} terminó con un error no controlado`, error instanceof Error ? error.stack : String(error));
                }
                finally {
                    this.cancelled.delete(runId);
                }
            }
        }
        finally {
            this.draining = false;
        }
    }
    /** Lets a test wait for the queue to settle without polling a private field. */
    async idle() {
        while (this.draining || this.pending.length > 0)
            await new Promise((resolve) => setImmediate(resolve));
    }
};
exports.InMemoryRunQueue = InMemoryRunQueue;
exports.InMemoryRunQueue = InMemoryRunQueue = InMemoryRunQueue_1 = __decorate([
    (0, common_1.Injectable)()
], InMemoryRunQueue);
//# sourceMappingURL=in-memory-queue.js.map