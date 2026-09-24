import { signedOutText, type AuthFailure } from "./account";
import * as cp from "./cp";
import type { InstanceConfig } from "./instance";
import type { SignInAuth } from "./signInAuth";
import type { Me, SessionToken } from "./wire";

export interface GateState {
  phase: "signed_out" | "loading" | "ready";
  me: Me | null;
  config: InstanceConfig | null;
  authError: string | null;
}

class GateStore implements SignInAuth {
  private listeners = new Set<() => void>();
  private snapshot: GateState = {
    phase: cp.currentCredential() === null ? "signed_out" : "loading",
    me: null,
    config: null,
    authError: null,
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): GateState => this.snapshot;

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private patch(fields: Partial<GateState>): void {
    this.snapshot = { ...this.snapshot, ...fields };
    this.emit();
  }

  async refreshConfig(): Promise<void> {
    try {
      this.patch({ config: await cp.instanceConfig() });
    } catch {
      // An older control plane answers 404 here, which is not a failure to report.
    }
  }

  async refreshMe(): Promise<void> {
    try {
      this.patch({ me: await cp.me() });
    } catch {
      // A finished credential was already signed out inside cpFetch.
    }
  }

  async login(name: string, password: string): Promise<void> {
    const me = await cp.login(name, password);
    this.patch({ me, authError: null });
    await this.settle();
  }

  async adoptSession(token: SessionToken): Promise<void> {
    cp.setSession(token.token);
    this.patch({ me: token.user, authError: null });
    await this.settle();
  }

  private async settle(): Promise<void> {
    this.patch({ phase: "loading" });
    try {
      this.patch({ me: await cp.me(), phase: "ready", authError: null });
    } catch {
      // A finished credential has already set signed_out; an outage leaves loading, which still works.
    }
    await this.ensureDevice();
  }

  private async ensureDevice(): Promise<void> {
    if (cp.currentDevice() !== null) return;
    try {
      await cp.registerDevice();
    } catch {
      // Bookkeeping, and total on purpose: an older control plane refuses this with a 403.
    }
  }

  handleSignedOut(failure: AuthFailure): void {
    if (failure === "device_revoked") cp.forgetDevice();
    this.patch({ phase: "signed_out", me: null, authError: signedOutText(failure) });
  }

  async signOut(): Promise<void> {
    await cp.logout();
    window.location.href = "/";
  }

  /** Unreachable without the native shell; empty rather than throwing. */
  pickServer(): void {}

  async switchBack(): Promise<void> {}

  async forgetAccount(): Promise<void> {}
}

/** Named store because a webcheck regex expects that name in Gate.tsx. Wired in gate-main.tsx, since both registrations are last-writer-wins. */
export const store = new GateStore();
