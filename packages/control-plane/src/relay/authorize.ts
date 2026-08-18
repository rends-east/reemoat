import type { KeyObject } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AUTH_LEEWAY_MS } from "../../../../src/auth.js";
import { decodeToken, jwkToPublicKey, parseClaims, verifySignature } from "../../../../src/token.js";
import { machineStanding } from "../quota.js";
import { activeUser, grantFor, machineById } from "../store.js";

/**
 * May this caller reach this machine at all?
 *
 * This is the question the relay exists to ask, and the only one it answers. It
 * is what a generic tunnel — ngrok, Cloudflare — structurally cannot do: those
 * move bytes for whoever holds the URL. Here a request for a machine the caller
 * has no grant on is refused before a byte reaches the tunnel.
 *
 * **Coarse on purpose.** Whether a token may do a *particular* thing — write a
 * prompt, answer a permission, delete a workspace — stays with the daemon's
 * `requireScope`, which already decides it for the direct path. Re-deriving
 * method-to-scope here would be a second copy of that policy, and the two copies
 * would drift the first time a route was added. The relay decides reachability;
 * the daemon decides capability.
 *
 * Note what this can do that the daemon cannot: it reads live `users`, `machines`
 * and `grants` rows on every request. A revoked grant stops working here
 * immediately, where on the direct path it lasts until the token expires. The two
 * paths genuinely have different revocation windows and that is worth knowing
 * rather than assuming they match.
 */

export type RelayAuth =
  | {
      ok: true;
      subject: string;
      machineId: string;
      scopes: string[];
      /**
       * Epoch ms. Checked once, here, at open — and deliberately not again.
       *
       * A long-lived stream is not torn down by this relay when its token dies;
       * the daemon's own expiry re-check on its ping tick does that, which is the
       * same bound the direct path has. Two places deciding when a stream ends
       * would eventually disagree. Carried on the result for the audit trail.
       */
      expiresAt: number;
      tokenId: string;
    }
  | { ok: false; status: 401 | 403 | 404; code: string; message: string };

export interface RelayAuthorizer {
  authorize(token: string | null, now?: number): RelayAuth;
}

/**
 * The shortest interval between two key-set reads.
 *
 * A cache miss is either a key rotation or an unauthenticated caller sending a
 * random `kid`, and the two are indistinguishable at this point, so the miss path
 * must be bounded without making rotation slow.
 *
 * One second, deliberately small. It was ten, which bounded the flood nicely and
 * introduced a worse bug: a bogus `kid` refreshes the cache, and a token signed
 * by a genuinely new key arriving a moment later would then be *rejected* for the
 * rest of the window — valid tokens failing because an attacker warmed a
 * throttle. At one second a rotation is invisible and a flood still costs at most
 * one indexed read per second against a table with a handful of rows.
 */
export const KEY_REFRESH_MS = 1_000;

export function createRelayAuthorizer(db: DatabaseSync, issuer: string): RelayAuthorizer {
  /*
   * Public keys, cached by kid.
   *
   * Read straight from `public_jwk` rather than through `activeSigningKeys`,
   * which parses each row's private PEM. Verifying a token needs only the public
   * half, and this is the one code path in this service that runs on
   * unauthenticated input — keeping the signing key out of it entirely is worth
   * the four lines of SQL.
   */
  let cache = new Map<string, KeyObject>();
  let refreshedAt = 0;

  const refresh = (): void => {
    const rebuilt = new Map<string, KeyObject>();
    for (const row of db.prepare("SELECT kid, public_jwk FROM signing_keys WHERE retired_at IS NULL").all()) {
      let jwk: unknown;
      try {
        jwk = JSON.parse(String(row["public_jwk"]));
      } catch {
        continue;
      }
      const parsed = jwkToPublicKey(jwk);
      // An unparseable key is dropped rather than fatal, exactly as the daemon
      // treats one at enrollment: a rotation in flight must not take the relay down.
      if (parsed !== null) rebuilt.set(String(row["kid"]), parsed);
    }
    cache = rebuilt;
    refreshedAt = Date.now();
  };

  /**
   * ⚠ **Refreshed on age, not only on a miss — because retiring a key is not a
   * miss.**
   *
   * This read the cache first and refreshed only when a `kid` was absent, which
   * makes rotation work and makes **retirement silently not work**. The
   * documented order is `rotatekey` (both keys published), let the fleet
   * re-enroll, then `retirekey <old>`. After the rotation the cache holds *both*
   * keys, because the first token carrying the new `kid` missed and refilled it.
   * `retirekey` then deletes nothing this map can notice: the old `kid` is still
   * a hit, so no refresh is ever triggered, and the relay keeps accepting tokens
   * signed by the retired key until the process happens to restart. The one
   * operation whose entire purpose is to stop a key working did nothing here.
   *
   * The flood bound is unchanged and is why the age check comes first: at most
   * one indexed read per `KEY_REFRESH_MS`, whether the caller is a rotation or
   * somebody sending random `kid`s. What changes is only *when* that read is
   * allowed to happen — on a clock rather than on a stranger's cache miss.
   */
  const keyFor = (kid: string): KeyObject | null => {
    if (Date.now() - refreshedAt >= KEY_REFRESH_MS) refresh();
    return cache.get(kid) ?? null;
  };

  return {
    authorize(token, now = Date.now()) {
      if (token === null || token.length === 0) {
        return { ok: false, status: 401, code: "missing_token", message: "missing token" };
      }

      // Structural decode only. This deliberately hands back the payload as an
      // unparsed string, so reading a claim before the signature verifies is
      // awkward to write rather than natural.
      const decoded = decodeToken(token);
      if (!decoded.ok) {
        return { ok: false, status: 401, code: decoded.code, message: decoded.message };
      }

      const key = keyFor(decoded.header.kid);
      if (key === null) {
        return { ok: false, status: 401, code: "unknown_key", message: "token was signed by an unknown key" };
      }
      // Nothing below this line runs unless the bytes are ours.
      if (!verifySignature(decoded, key)) {
        return { ok: false, status: 401, code: "bad_signature", message: "token signature did not verify" };
      }

      const claims = parseClaims(decoded.payloadJson);
      if (claims === null) {
        return { ok: false, status: 401, code: "malformed_token", message: "token claims are malformed" };
      }
      if (claims.iss !== issuer) {
        return { ok: false, status: 401, code: "wrong_issuer", message: "token was issued by a different control plane" };
      }

      // Same leeway constant the daemon uses, so a token is not accepted here and
      // refused one hop later — which would look like the relay corrupting things.
      const notBefore = claims.nbf * 1000 - AUTH_LEEWAY_MS;
      const notAfter = claims.exp * 1000 + AUTH_LEEWAY_MS;
      if (now < notBefore) {
        return { ok: false, status: 401, code: "token_not_yet_valid", message: "token is not valid yet" };
      }
      if (now > notAfter) {
        return { ok: false, status: 401, code: "token_expired", message: "token has expired" };
      }

      /*
       * The routing key.
       *
       * `aud` is where the request goes. There is no machine id in the URL, so
       * there is nothing for it to disagree with: the only machine a caller can
       * address is the one their token was minted for. The audience binding that
       * stops one grant becoming a grant to the whole fleet is therefore
       * structural here, rather than a comparison somebody has to remember.
       */
      const machineId = claims.aud;

      const machine = machineById(db, machineId);
      // Same answer for "no such machine" and "no grant", below, so a caller
      // cannot enumerate the fleet by watching which refusal comes back.
      if (!machine || machine.revoked) {
        return { ok: false, status: 404, code: "machine_not_found", message: "no such machine" };
      }

      const user = activeUser(db, claims.sub);
      if (!user) {
        return { ok: false, status: 403, code: "user_disabled", message: "this user has been disabled" };
      }

      const scopes = grantFor(db, claims.sub, machineId);
      if (scopes === null) {
        return { ok: false, status: 404, code: "machine_not_found", message: "no such machine" };
      }
      if (scopes.length === 0) {
        return { ok: false, status: 403, code: "no_scopes", message: "this grant carries no usable scopes" };
      }

      /*
       * The owner's machine limit, and it is checked **last** on purpose.
       *
       * Everything above answers the same 404 for "no such machine" and "no
       * grant", so a caller holding one token cannot map the fleet by watching
       * which refusal comes back. This one names a real state — which is the
       * point, because the owner has to be able to see why their machine
       * stopped — so it has to sit behind a proved grant. Asked any earlier it
       * would be an enumeration oracle: any valid token would report whether an
       * arbitrary `aud` exists and is over somebody's limit.
       *
       * 403 rather than 404, matching `no_scopes` one line above and for its
       * reason: the caller is known, the machine is present, and the refusal is
       * about policy rather than existence.
       *
       * **Read live, with no cache.** `KEY_REFRESH_MS` above exists because a
       * key-set miss is reachable by an *unauthenticated* caller sending a
       * random `kid`; nothing below `verifySignature` can be amplified that way,
       * and this sits beside three reads that are already unconditional — three
       * statements becoming five, not zero becoming one. A TTL would also have
       * no correct invalidation: in `external` mode this is a separate process
       * from the one that writes the row, so any window becomes the floor on
       * "the admin raised my limit and it still does not work". If profiling
       * ever demands a cache, the answer is `PRAGMA data_version`, which SQLite
       * bumps when another connection commits — not a timer.
       *
       * `null` — a machine nobody owns — passes, unchanged. That is every row
       * registered before ownership existed and every one whose owner was
       * deleted, and refusing them would take them off the network on deploy.
       */
      const standing = machineStanding(db, machineId);
      /*
       * The **owner's** ban, which nothing here read until now.
       *
       * `activeUser` above asks whether the *caller* is banned. Nobody asked
       * about the owner, so banning somebody left every machine they own
       * working for anybody holding a grant, and left their daemons holding
       * tunnels: the ban stopped them signing in and stopped nothing else.
       *
       * **The code is `owner_disabled`, and it must not be `user_disabled`.**
       * The client signs a tab out on `user_disabled` — correctly, it means
       * "you are banned" — and reusing it here would sign out a perfectly good
       * grantee for touching somebody else's suspended machine. Two facts, two
       * codes, and `webcheck` pins that only one of them ends a session.
       */
      if (standing !== null && standing.ownerDisabled) {
        return {
          ok: false,
          status: 403,
          code: "owner_disabled",
          message: "this machine's owner has been disabled, so it is switched off",
        };
      }
      if (standing !== null && standing.over) {
        return {
          ok: false,
          status: 403,
          code: "machine_over_limit",
          message:
            standing.ownerId === claims.sub
              ? "you are over your machine limit, so the machines you added most recently are switched off. " +
                "Retire one, or ask whoever runs this control plane to raise the limit — nothing has been deleted."
              : "this machine is over its owner's machine limit and is switched off",
        };
      }

      return {
        ok: true,
        subject: claims.sub,
        machineId,
        scopes,
        expiresAt: claims.exp * 1000,
        tokenId: claims.jti,
      };
    },
  };
}
