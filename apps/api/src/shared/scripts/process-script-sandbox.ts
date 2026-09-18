import { fork } from "node:child_process";
import { join } from "node:path";
import { Injectable } from "@nestjs/common";

import {
  SCRIPT_LIMITS,
  failedOutcome,
  sanitizeOutcome,
  type ScriptInput,
  type ScriptOutcome,
  type ScriptSandboxPort,
} from "./script-sandbox";

/** Compiled next to this file, in `dist` and in `dist-test` alike. */
const WORKER = join(__dirname, "script-worker.js");

/**
 * One child process per script.
 *
 * Forking costs a few tens of milliseconds, which next to the request the script belongs to is
 * noise — and it buys the property that matters: nothing a script does survives it. A pool would
 * have to prove that a context left no trace in the next one; a fresh process does not.
 */
@Injectable()
export class ProcessScriptSandbox implements ScriptSandboxPort {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  async run(input: ScriptInput): Promise<ScriptOutcome> {
    await this.acquire();
    try {
      return await this.spawn(input);
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < SCRIPT_LIMITS.concurrency) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) =>
      this.waiting.push(() => {
        this.running += 1;
        resolve();
      }),
    );
  }

  private release(): void {
    this.running -= 1;
    this.waiting.shift()?.();
  }

  private spawn(input: ScriptInput): Promise<ScriptOutcome> {
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    return new Promise((resolve) => {
      let settled = false;
      let stderr = "";
      const child = fork(WORKER, [], {
        // Replaces the parent's flags rather than inheriting them: a test runner's or a debugger's
        // `--inspect` has no business in here.
        execArgv: [
          "--permission",
          `--allow-fs-read=${WORKER}`,
          "--disallow-code-generation-from-strings",
          `--max-old-space-size=${SCRIPT_LIMITS.heapMb}`,
        ],
        // Empty, not inherited. This is the line that keeps DATABASE_URL, the JWT secrets and the
        // encryption key out of the process running somebody's code.
        env: {},
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        serialization: "json",
      });
      const finish = (outcome: ScriptOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve(outcome);
      };
      const timer = setTimeout(
        () => finish(failedOutcome(`El script tardó más de ${SCRIPT_LIMITS.totalMs / 1000} s y se detuvo`, elapsed())),
        SCRIPT_LIMITS.totalMs,
      );

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 4_000) stderr += chunk.toString();
      });
      child.on("message", (message: unknown) => {
        const reply = (message ?? {}) as { result?: unknown; failure?: unknown };
        if (typeof reply.failure === "string") return finish(failedOutcome(reply.failure, elapsed()));
        let parsed: unknown = null;
        try {
          parsed = typeof reply.result === "string" ? JSON.parse(reply.result) : null;
        } catch {
          parsed = null;
        }
        finish(sanitizeOutcome(parsed, elapsed()));
      });
      child.on("error", (error) =>
        finish(failedOutcome(`No se pudo arrancar el proceso del script: ${error.message}`, elapsed())),
      );
      // `close` and not `exit`: it comes after the IPC channel is drained, so a reply sent just
      // before exiting is never mistaken for a process that died silent.
      child.on("close", (code, signal) =>
        finish(
          failedOutcome(
            /heap out of memory|allocation failed/i.test(stderr)
              ? `El script superó el límite de ${SCRIPT_LIMITS.heapMb} MB de memoria`
              : `El proceso del script terminó sin responder (${signal ?? `código ${code}`})`,
            elapsed(),
          ),
        ),
      );

      child.send(
        {
          input,
          limits: {
            scriptMs: SCRIPT_LIMITS.scriptMs,
            maxLogs: SCRIPT_LIMITS.maxLogs,
            maxLineLength: SCRIPT_LIMITS.maxLineLength,
            maxTests: SCRIPT_LIMITS.maxTests,
            maxValueLength: SCRIPT_LIMITS.maxValueLength,
            maxTemplateLength: SCRIPT_LIMITS.maxTemplateLength,
            maxVisualizationData: SCRIPT_LIMITS.maxVisualizationData,
          },
        },
        (error) => {
          if (error) finish(failedOutcome(`No se pudo pasar el script a su proceso: ${error.message}`, elapsed()));
        },
      );
    });
  }
}
