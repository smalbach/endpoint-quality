"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var RedisRunQueue_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisRunQueue = void 0;
const common_1 = require("@nestjs/common");
/**
 * The queue for a hosted deployment.
 *
 * What Redis buys over the in-memory adapter is the two things a shared instance needs: a run
 * survives an API restart, and several can proceed at once without one operator's matrix waiting
 * behind another's.
 *
 * **BullMQ is loaded lazily and by name.** A self-hosted install running `QUEUE_DRIVER=memory`
 * must not need the dependency present at all, and a static import would make it a hard
 * requirement of the bundle. The failure, when it happens, says exactly what to install.
 */
let RedisRunQueue = RedisRunQueue_1 = class RedisRunQueue {
    redisUrl;
    queueName;
    logger = new common_1.Logger(RedisRunQueue_1.name);
    queue;
    worker;
    constructor(redisUrl, queueName = "runs") {
        this.redisUrl = redisUrl;
        this.queueName = queueName;
    }
    /**
     * Loaded through a variable specifier so the compiler does not demand the package.
     *
     * That is the point rather than a trick: `bullmq` is a real optional dependency, and a static
     * import would make a self-hosted install running `QUEUE_DRIVER=memory` fail to build over a
     * queue it never uses. The error, when it does happen, says what to do about it.
     */
    async bullmq() {
        const specifier = "bullmq";
        try {
            return await Promise.resolve(`${specifier}`).then(s => __importStar(require(s)));
        }
        catch {
            throw new Error("QUEUE_DRIVER=redis requiere la dependencia bullmq: instálala o usa QUEUE_DRIVER=memory");
        }
    }
    async ensureQueue() {
        if (!this.queue) {
            const { Queue } = await this.bullmq();
            this.queue = new Queue(this.queueName, { connection: { url: this.redisUrl } });
        }
        return this.queue;
    }
    async enqueue(runId) {
        const queue = await this.ensureQueue();
        // The run id is the job id, so enqueuing the same run twice is one job rather than two
        // workers walking the same matrix against the same target.
        await queue.add("run", { runId }, { jobId: runId, removeOnComplete: true, removeOnFail: false });
    }
    process(handler) {
        void (async () => {
            const { Worker } = await this.bullmq();
            this.worker = new Worker(this.queueName, async (job) => handler(job.data.runId), {
                connection: { url: this.redisUrl },
                // One at a time per worker. Concurrency comes from running more API instances, which is
                // the knob an operator can actually reason about.
                concurrency: 1,
            });
            this.worker.on("failed", (job, error) => {
                this.logger.error(`La corrida ${job?.id} falló en la cola: ${error.message}`);
            });
        })();
    }
    async cancel(runId) {
        const queue = await this.ensureQueue();
        // Two paths, because a run can be waiting or already in flight: remove the job if it has not
        // started, and leave the flag for the worker to notice at the next case boundary.
        await queue.remove(runId).catch(() => undefined);
        const { Queue } = await this.bullmq();
        void Queue;
        await (await this.ensureQueue()).client.then((client) => client.set(`run:cancelled:${runId}`, "1", "EX", 3600));
    }
    async isCancelled(runId) {
        const queue = await this.ensureQueue();
        const client = await queue.client;
        return (await client.get(`run:cancelled:${runId}`)) === "1";
    }
    async onModuleDestroy() {
        await this.worker?.close();
        await this.queue?.close();
    }
};
exports.RedisRunQueue = RedisRunQueue;
exports.RedisRunQueue = RedisRunQueue = RedisRunQueue_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [String, Object])
], RedisRunQueue);
//# sourceMappingURL=redis-queue.js.map