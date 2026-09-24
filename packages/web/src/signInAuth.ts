/** Lets SignIn act without importing a store, keeping the transport out of the gate bundle; each bundle's store provides it once. */
export interface SignInAuth {
  /** Rejects on failure: SignIn draws the error beside the field. */
  login(name: string, password: string): Promise<void>;
  pickServer(): void;
  switchBack(): Promise<void>;
  forgetAccount(): Promise<void>;
}

let provided: SignInAuth | null = null;

export function provideSignInAuth(auth: SignInAuth): void {
  provided = auth;
}

/** Throws when nothing was provided: that is a broken build, and a no-op would be a dead Sign in button. */
export function signInAuth(): SignInAuth {
  if (provided === null) throw new Error("no sign-in store in this bundle");
  return provided;
}
