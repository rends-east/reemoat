import { IDLE_PARK_SWEEP_MS } from "./registry.js";

// One clock for two sweeps, park before reap, so a turn abandoned this tick is not parked in it (Q2.224).
// Whether a session may go is ManagedSession.parkable's; this class only decides when to look.
export interface IdleParkOptions {
  park: () => Promise<string[]>;
  /** A thunk read at every tick, since the environment is read after construction; it gates park alone. */
  enabled?: () => boolean;
  reap?: () => readonly string[];
  reapEnabled?: () => boolean;
  schedule?: (fn: () => void, ms: number) => { cancel: () => void };
  sweepMs?: number;
  /** Reported so an operator can tell a parked agent from a crashed one. */
  onParked?: (ids: readonly string[]) => void;
  onAbandoned?: (ids: readonly string[]) => void;
}

export class IdleParking {
  private timer: { cancel: () => void } | null = null;
  private stopped: Promise<void> | null = null;
  private running = false;

  private constructor(private readonly options: IdleParkOptions) {}

  /** Always armed: enabled is asked at every tick, not once. */
  static start(options: IdleParkOptions): IdleParking {
    const parking = new IdleParking(options);
    parking.arm();
    return parking;
  }

  shutdown(): Promise<void> {
    return (this.stopped ??= this.doShutdown());
  }

  private async doShutdown(): Promise<void> {
    this.timer?.cancel();
    this.timer = null;
    // An in-flight sweep is not awaited: shutdown stops every session anyway, and the first exit record wins.
  }

  private arm(): void {
    if (this.stopped !== null) return;
    const schedule =
      this.options.schedule ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref();
        return { cancel: () => clearTimeout(handle) };
      });
    this.timer = schedule(() => void this.tick(), this.options.sweepMs ?? IDLE_PARK_SWEEP_MS);
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.stopped !== null) return;
    // Skipped, not queued: guards an injected schedule that fires twice.
    if (!this.running) {
      this.running = true;
      // One try each: a throw in one sweep must not cost the other its turn.
      await sweep(async () => {
        if (!(this.options.enabled?.() ?? true)) return;
        const parked = await this.options.park();
        if (parked.length > 0) this.options.onParked?.(parked);
      });
      await sweep(() => {
        if (!(this.options.reapEnabled?.() ?? true)) return;
        const abandoned = this.options.reap?.() ?? [];
        if (abandoned.length > 0) this.options.onAbandoned?.(abandoned);
      });
      this.running = false;
    }
    this.arm();
  }
}

async function sweep(run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
  } catch {
    // Housekeeping: the next sweep is a minute away, and a throw here would stop the timer arming.
  }
}
