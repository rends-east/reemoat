/** How this daemon speaks to an identity provider; a driver stands in for it, and one file holds the real one. */
export interface IdentityTransport {
  postForm(url: string, form: Record<string, string>, signal: AbortSignal): Promise<IdentityAnswer>;
  getJson(url: string, signal: AbortSignal): Promise<IdentityAnswer>;
}

export interface IdentityAnswer {
  status: number;
  /** Parsed JSON, or null where the body was not JSON. */
  body: unknown;
}

/** What a finished sign-in holds. Stored whole; the access token is the only part ever sent anywhere but its issuer. */
export interface SignInTokens {
  /** Issued to this machine by the provider, where it issues one per sign-in. */
  clientId: string;
  access: string;
  refresh: string;
  /** Milliseconds since the epoch at which the access token stops working. */
  expiresAt: number;
  /** A name a person recognises the account by, from the identity token; never an id. */
  account: string | null;
}

/** One attempt, between the page a person is sent to and what that page hands back. Held by the daemon and never sent to a client, authorizeUrl excepted. */
export interface SignInAttempt {
  authorizeUrl: string;
  state: string;
  verifier: string;
  nonce: string;
  redirectUri: string;
  hostId: string;
}

/** A refusal with a sentence a person reads; code is for a driver and for data.code. */
export class SignInError extends Error {
  constructor(
    readonly code: "sign_in_refused" | "sign_in_not_eligible" | "sign_in_unreachable" | "sign_in_malformed",
    message: string,
  ) {
    super(message);
    this.name = "SignInError";
  }
}

export interface SignInFlow {
  id: string;
  /** The only origin a client may be told to open. */
  authorizeOrigin: string;
  /** hostId is this machine's own, minted once and kept; redirectUri is where the page hands back. */
  begin(input: { redirectUri: string; hostId: string }): SignInAttempt;
  /** What the redirect carried, to tokens. Throws SignInError. */
  complete(
    attempt: SignInAttempt,
    redirected: URLSearchParams,
    transport: IdentityTransport,
    now: number,
    signal: AbortSignal,
  ): Promise<SignInTokens>;
  /** New tokens, or "signed_out" where the provider no longer honours the refresh token. Throws SignInError where it could not be asked. */
  refresh(held: SignInTokens, transport: IdentityTransport, now: number, signal: AbortSignal): Promise<SignInTokens | "signed_out">;
}
