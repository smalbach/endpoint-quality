/** Time as a dependency. A handler that calls `new Date()` cannot be tested for expiry without
 * either waiting or mocking globals; one that asks the clock can. */
export const CLOCK = Symbol("CLOCK");

export interface ClockPort {
  now(): Date;
}

export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
}

/** A clock the tests move by hand. */
export class FixedClock implements ClockPort {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(date: Date): void {
    this.current = new Date(date);
  }
}
