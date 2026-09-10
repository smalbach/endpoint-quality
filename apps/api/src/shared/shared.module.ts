import { Global, Module } from "@nestjs/common";
import { CLOCK, SystemClock } from "./clock/clock.port";
import { SECRET_CIPHER } from "./crypto/secret-cipher";
import { SecretCipherProvider } from "./crypto/secret-cipher.provider";

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
 *
 * The cipher is here for the same reason. It was registered in `environments`, which owned the
 * only thing that needed it — until the spec import started storing the headers a contract behind
 * authentication needs, at which point `specs` would have had to import `environments` to reach
 * a symbol that has nothing to do with environments.
 */
@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: SECRET_CIPHER, useClass: SecretCipherProvider },
  ],
  exports: [CLOCK, SECRET_CIPHER],
})
export class SharedModule {}
