//! The control-plane credential, at rest.
//!
//! **Keyed on the account — `<origin>#<user id>` — and that is the whole of the
//! scoping rule.** A browser gets the origin half for free — one origin, one
//! `localStorage` — and a native shell does not: there is one webview origin for
//! every server somebody might point this app at, and every account on each. So
//! the account is the *lookup key*, which means a credential cannot be read for a
//! server it was not issued by, nor for a second person on that same server.
//! Structurally, rather than because a code path remembered to clear it on a
//! change. Q1.651.
//!
//! ⚠ **Which account is the host's to say, never the page's.** Two commands write
//! an entry, each only after `GET /v1/me` has said whose token it is:
//! `host_credential_set`, for the webview that asked, and a legacy seat's
//! `host_account_confirm`, moving a pre-accounts entry from the bare origin to the
//! account it turns out to be (`accounts::bind`). One hands one over,
//! `host_boot`, for the calling webview's own account and no other.
//!
//! What is never stored here: the person's password (there is no "remember me" —
//! `POST /v1/me/password` asks for the current one whichever credential presents,
//! and a stored password would make that a formality), and any daemon credential.
//! A machine token is 300 seconds long and derived; it belongs in
//! `packages/web/src/machine.ts` and nowhere near an OS keyring.

/*
 * ⚠ **Two stores, one set of verbs, and the `use` is where they are held apart.**
 *
 * The desktop arm is `keyring`'s `v1` façade — macOS Keychain, Windows Credential
 * Manager, the freedesktop Secret Service. That façade **refuses Android and iOS
 * at run time while compiling** (`keyring-4.2.0/src/v1.rs:109-128`), so the
 * mobile arm reaches past it to `keyring-core` and names its backing store
 * itself.
 *
 * Aliased rather than branched at every call site: both `Entry` types expose the
 * same three methods, so `PlatformStore`'s impl below is one body that compiles
 * against whichever arm is active. A second impl would be two places for
 * `account_for`'s scoping rule to drift apart.
 */
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use keyring::{Entry, Error as StoreError};
#[cfg(target_os = "android")]
use keyring_core::{Entry, Error as StoreError};

/// One constant, because Windows keys on a target string and macOS on
/// service+account, and two spellings would be two stores on two platforms.
const SERVICE: &str = "com.reemoat.app";

/// Every secret this app keeps, and there are two.
///
/// A named set rather than a string at each call site, so adding a member is a
/// visible edit in one place — which is what this set was built for, and this is
/// that edit. There is still deliberately **no device id** here: an id is an
/// identifier rather than a secret, it is read only after a session token has
/// already resolved, and a store that silently discards writes would have this
/// app register a new device on every launch. `config.rs` keeps it, and says so.
pub const CREDENTIAL: &str = "credential";

/// The device's X25519 private key, base64url, 32 raw bytes.
///
/// Scoped per account like the credential beside it, because the row it names
/// belongs to one user on one fleet: a key registered with one server means
/// nothing to another, and reusing it across both would link the two
/// installations to each other for no benefit. ⚠ **That argument reaches two
/// accounts on one server too**: one key on two users' device rows tells anybody
/// who can see both that they are one computer, and the control plane has no
/// uniqueness on the column to refuse it. So the key is per account, and the one
/// that ever moves — a pre-accounts key under the bare origin — moves only to the
/// account proved to own it (`device::copy_key`).
pub const DEVICE_KEY: &str = "device_key";

/// What a secret store has to do, and pointedly not more.
///
/// A trait with one implementation, for the reason `SessionRuntime` is one in the
/// daemon: it is the seam a second platform arrives through, and it costs nothing
/// now. `keyring`'s Android support is behind its own feature with a different API
/// and iOS reaches the Apple keychain by a third path, so scattering
/// `Entry::new(…)` through the commands is precisely what would make a mobile arm
/// expensive later.
///
/// ⚠ **This block said a private key may not use `read`/`write`, and one now
/// does. The amendment is here rather than in a plan nobody reads later.**
///
/// What it said: *a key this process can read is a key this process can leak, so
/// the future shape for one is a `sign(key, bytes)` that never returns it, backed
/// by the Secure Enclave or a TPM.* Two of those three clauses still stand and
/// one is not available.
///
/// **Not available:** the Secure Enclave does P-256 and nothing else. The key the
/// Noise handshake needs is X25519, so a non-extractable static simply does not
/// exist on this platform for this algorithm. That is a fact about the hardware
/// rather than a corner cut, and pretending otherwise in a security document is
/// the failure this repository names elsewhere as *a property the code appears to
/// have and nothing enforces*.
///
/// **Still true, and it is what the refusal actually bought:** the key never
/// crosses the bridge. `device.rs` performs the two Diffie-Hellman operations the
/// handshake needs and returns a shared secret; no command returns the key
/// itself, so the webview — the one place somebody else's JavaScript could ever
/// run — cannot read it. And there is still no `list`: enumerating is what a
/// rotation would want, and shipping the verb now is shipping the feature.
///
/// So the honest claim is *the page cannot read it*, not *this process cannot*.
/// `SECURITY.md` says it in those words.
pub trait SecretStore {
    fn read(&self, key: &str, scope: &str) -> Option<String>;
    fn write(&self, key: &str, scope: &str, value: &str) -> Result<(), String>;
    fn erase(&self, key: &str, scope: &str) -> Result<(), String>;
}

/// ⚠ **The one platform failure in this file that compiles, and therefore the one
/// that has to be made not to.**
///
/// `keyring`'s `v1` feature is macOS Keychain, Windows Credential Manager and the
/// freedesktop Secret Service — and on iOS or Android its `set_credential_store`
/// returns `Err(Invalid("platform", "must be macOS, Windows, or a non-iOS,
/// non-Android *nix variant"))` at **run time**, having compiled perfectly
/// (`keyring-4.2.0/src/v1.rs:109-128`, read on this checkout).
///
/// So an iOS build made today would link, start, draw, and silently never keep a
/// sign-in: `entry()` answers `Err`, `read` answers `None`, `write` fails,
/// `probe()` is `false`, and the person retypes their password on every launch
/// while the app tells them their store is not durable. Every other thing an iOS
/// build is missing — `gen/apple`, a toolchain, a signing key — fails loudly at
/// build or install time. This one passes every gate and arrives at a user.
///
/// A refusal at compile time is the only place it can be caught, so it is here.
/// **Android took the other road and is already written**: `entry()` below names
/// `android-native-keyring-store` through `keyring-core`. **Deleting this is a
/// step in writing the iOS arm, not a step before it**: what replaces it is that
/// same shape against `apple-native-keyring-store`. `probe()` is what will say
/// whether the replacement actually works, and it needs no change either way.
#[cfg(target_os = "ios")]
compile_error!(
    "keyring's `v1` feature has no credential store on iOS or Android: it compiles \
     and then refuses at run time, so this build would never keep a sign-in. Write \
     the mobile `SecretStore` arm (keyring-core + apple-native-keyring-store / \
     android-native-keyring-store) and delete this refusal in the same change."
);

/// The one implementation: the platform's own credential store.
pub struct PlatformStore;

impl SecretStore for PlatformStore {
    fn read(&self, key: &str, scope: &str) -> Option<String> {
        let entry = entry(&account_for(key, scope)).ok()?;
        match entry.get_password() {
            Ok(value) if !value.is_empty() => Some(value),
            // Absent, locked, or a store that answered an error: all of them mean
            // "ask for the password again", which is a working degraded mode.
            _ => None,
        }
    }

    fn write(&self, key: &str, scope: &str, value: &str) -> Result<(), String> {
        entry(&account_for(key, scope))?
            .set_password(value)
            .map_err(|e| format!("could not save the sign-in: {e}"))
    }

    fn erase(&self, key: &str, scope: &str) -> Result<(), String> {
        let entry = entry(&account_for(key, scope))?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            // Deleting what is not there is the outcome the caller wanted.
            Err(StoreError::NoEntry) => Ok(()),
            Err(e) => Err(format!("could not clear the sign-in: {e}")),
        }
    }
}

/// `#` as the delimiter, chosen rather than defaulted: a URL origin cannot
/// contain one, so "the key is the origin" needs no escaping to be unambiguous —
/// and `credential#<origin>#<user id>` is an extension of this shape rather than a
/// migration away from it. ⚠ **That extension is taken now** (Q1.651): a scope is
/// `<origin>#<user id>`, the user id is refused if it could carry a `#` of its own
/// (`accounts::is_user_id`), and a bare origin — an entry from before accounts —
/// can therefore never equal an account's scope.
fn account_for(key: &str, scope: &str) -> String {
    format!("{key}#{scope}")
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| format!("no credential store: {e}"))
}

/// Hand the Android application context to `ndk-context`, from the activity.
///
/// ⚠ **Nothing else does this, and that was measured the hard way.**
/// `android-native-keyring-store` reaches the context through `ndk-context`, and
/// `ndk_context::android_context()` is an `.expect()` — it **panics** when the
/// context was never set. The crate ships a Kotlin companion of its own that
/// calls in and sets it; that companion is not in this APK. And
/// `initialize_android_context` is called by exactly two crates in this whole
/// dependency tree — `ndk-context` itself and that store. **Tauri, tao and wry
/// call it never.**
///
/// So the first Android build crashed on launch: `probe()` ran in `setup()`,
/// reached for a context nobody had set, and panicked before a pixel was drawn.
/// `MainActivity.kt` calls this in `onCreate`, which is the earliest moment the
/// context exists and is still before Tauri's `setup`.
///
/// ⚠ **Two handles, not one, and the second has no degraded mode.**
///
/// The context also has to reach `rustls-platform-verifier`, which is a
/// *separate* store from `ndk-context` and reads nothing the other one wrote.
/// `reqwest` 0.13's `default-tls` is `rustls`, and that feature pulls the
/// verifier — so it is what checks every certificate on the `/v1` leg. Its
/// `src/android.rs` opens *"On Android, initialization must be done before any
/// verification is attempted"*, and the `global()` every verification goes
/// through ends `.expect("Expect rustls-platform-verifier to be initialized")`.
/// `Verifier::new` does not touch it; the first **request** does. So with this
/// second half absent the app compiles, links, installs, launches, draws, and
/// panics on the first call to the control plane.
///
/// **Each half gets its own `catch_unwind`, and that is the whole reason there
/// are two.** A panic crossing an `extern "system"` boundary aborts the process,
/// and there is a reachable one: `ndk_context::initialize_android_context` ends
/// `assert!(previous.is_none())`, while `android-native-keyring-store` exports a
/// second `Java_..._initializeNdkContext` from this same `.so` that would set it
/// first. Under one shared guard that abort would also take the TLS init with
/// it — and the store has a documented degraded mode (`probe()` answers `false`
/// and the app says the sign-in will be asked for again) where TLS has none.
///
/// # Safety
/// Called by the JVM from `MainActivity.onCreate`. The null checks below are the
/// only part of that contract this code enforces; `HELD` makes a second call a
/// no-op, and `init_with_env` is `get_or_try_init` inside, so both halves are
/// idempotent rather than merely expected-once.
#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_reemoat_app_MainActivity_initNdkContext(
    env: jni::JNIEnv,
    _class: jni::objects::JObject,
    context: jni::objects::JObject,
) {
    /*
     * ⚠ **Both raw pointers are checked here, once, because both halves below
     * would take a null and keep it.** `jni` 0.21's `new_global_ref` is
     * `jni_unchecked!` with no null test — the `new_weak_ref` directly beneath it
     * checks and documents returning `None`, which is how you can tell the
     * omission is deliberate upstream rather than an oversight — so a null would
     * be cached into `ndk-context`'s process-global slot for the life of the
     * process. `jni` 0.22's `EnvUnowned::from_raw` asserts instead, which under
     * `extern "system"` is an abort.
     */
    let raw_env = env.get_raw();
    let raw_context = context.as_raw();
    if raw_env.is_null() || raw_context.is_null() {
        return;
    }
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        adopt_context(&env, &context);
    }));
    /*
     * The verifier's half, through its own `jni` major. `jni-sys` 0.3 aliases
     * `_jobject` to `jni-sys` 0.4's own type, so the `jobject` cast is an
     * identity and only the `JNIEnv` interface pointer — which each major
     * declares for itself — actually changes shape.
     */
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut unowned = unsafe { jni22::EnvUnowned::from_raw(raw_env.cast()) };
        let _ = unowned
            .with_env(|env| {
                let context = unsafe { jni22::objects::JObject::from_raw(env, raw_context.cast()) };
                rustls_platform_verifier::android::init_with_env(env, context)
            })
            .into_outcome();
    }));
}

/// The `ndk-context` half, lifted out of the entry point so each half can be
/// guarded on its own.
///
/// `HELD` caches the **attempt** rather than the success: a `GlobalRef` that
/// could not be made is a JVM in a state a retry will not improve, and unlike
/// the credential store one bad moment here is not something a later call can
/// repair — the context is set once per process by contract.
#[cfg(target_os = "android")]
fn adopt_context(env: &jni::JNIEnv<'_>, context: &jni::objects::JObject<'_>) {
    use std::sync::OnceLock;
    // A `GlobalRef` rather than the local one: the local reference dies when
    // `onCreate` returns, and the store dereferences it much later.
    static HELD: OnceLock<Option<jni::objects::GlobalRef>> = OnceLock::new();
    HELD.get_or_init(|| {
        let Ok(held) = env.new_global_ref(context) else {
            return None;
        };
        // `new_global_ref` does not reject a null; see the entry point above.
        if held.as_obj().as_raw().is_null() {
            return None;
        }
        let Ok(vm) = env.get_java_vm() else {
            return None;
        };
        unsafe {
            ndk_context::initialize_android_context(
                vm.get_java_vm_pointer() as *mut std::ffi::c_void,
                held.as_obj().as_raw() as *mut std::ffi::c_void,
            );
        }
        Some(held)
    });
}

/// The same three verbs on Android, over SharedPreferences and the Android
/// Keystore.
///
/// ⚠ **`keyring`'s `v1` façade is bypassed deliberately, not forgotten.** It has
/// no store for this platform and says so only at run time — which is why the
/// desktop `use` above and this function are the two halves of one decision.
///
/// **The store is set once and only the *success* is remembered.**
/// `set_default_store` is global and idempotent-by-accident rather than by
/// contract, and `android_native_keyring_store::Store::new()` reaches for the
/// Android application context through `ndk-context`; calling it per entry would
/// be a JNI round trip on every `host_boot`, every credential write and **twice
/// per Noise handshake** — `commands.rs`'s own list of what is on a hot path. So
/// a `OnceLock` still stands in front of it and the hot path is still what it
/// was: one atomic load, no lock, no JNI.
///
/// ⚠ **What is no longer cached is the failure, and caching that was a defect
/// with no way out of it.** The cell used to hold the whole `Result`, so the
/// first attempt decided the life of the process: a `probe()` that ran before
/// `initNdkContext` had succeeded — or during any transient the Keystore can
/// have — left `Err` in it, and `read`, `write`, `erase` and `probe` answered
/// from that cell for ever. The app told somebody their sign-in would not be
/// kept and went on telling them after the cause was gone, until they
/// force-stopped it. The cost argument above is an argument for caching a
/// **success**; it was never an argument for making a failure permanent, and
/// `adopt_context` above states the one case where the opposite is right.
///
/// The retry is a `Mutex` rather than a second `OnceLock` because what it has to
/// buy is *serialisation* rather than memory: `host_boot` reads the credential
/// and the device key on the same tick, so a burst of callers arriving at an
/// unset cell must make one attempt between them rather than one each. Nothing
/// is held across it but the attempt, and a poisoned lock is taken anyway — a
/// holder's panic is already caught in `install_default_store`, and refusing to
/// retry because of one would be the permanent failure arriving by another door.
#[cfg(target_os = "android")]
fn entry(account: &str) -> Result<Entry, String> {
    use std::sync::{Mutex, OnceLock};

    static READY: OnceLock<()> = OnceLock::new();
    static ATTEMPT: Mutex<()> = Mutex::new(());

    // The hot path, and the whole reason there is a cache at all: one acquire
    // load. Everything below runs only while the store is still unset.
    if READY.get().is_none() {
        let _serialized = ATTEMPT
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Tested again under the lock, so the callers that queued behind a
        // successful attempt do not each make a second one.
        if READY.get().is_none() {
            install_default_store()?;
            // Ignored rather than unwrapped: the test above is under this same
            // lock, so it cannot lose — and unwrapping a `Result` that cannot be
            // `Err` is a panic site added for nothing, in a file whose whole
            // subject one function up is not ending the process.
            let _ = READY.set(());
        }
    }
    Entry::new(SERVICE, account).map_err(|e| format!("no credential store: {e}"))
}

/// Reach the Android credential store and make it the default, once.
///
/// ⚠ **`catch_unwind`, and it is the difference between a degraded app and no
/// app.** Reaching the store is a JNI call, and the layer under it panics rather
/// than answering `Err` when the Android context was never set:
/// `ndk_context::android_context()` is an `.expect()`, and the vault calls it on
/// the way to every `getSharedPreferences`. That took the whole process down on
/// the first build, from inside `setup`, before anything was drawn.
///
/// A store that cannot be reached is a state this file already has a sentence
/// for: `probe()` answers `false` and the app says it will ask for the password
/// again next time. That is a working degraded mode; an abort is not, and nothing
/// about a credential store earns the right to end the process.
///
/// **Safe to call again after a failure, which is what makes `entry()`'s retry
/// legal rather than merely hopeful.** `Store::new()` goes through
/// `by_store::vault::lookup`, which hands back an already-in-use vault for a
/// matching config instead of building a second one, and
/// `keyring_core::set_default_store` is a write into an `RwLock<Option<_>>`. So a
/// second call after an `Err` costs one more JNI round trip and changes nothing
/// else — read off `android-native-keyring-store-1.0.0/src/by_store/vault.rs:35-62`
/// and `keyring-core-1.0.0/src/lib.rs:65-71` on this checkout, there being no
/// Android device in this loop to measure it on.
#[cfg(target_os = "android")]
fn install_default_store() -> Result<(), String> {
    std::panic::catch_unwind(|| {
        android_native_keyring_store::Store::new()
            // A closure rather than the bare function: `set_default_store` takes
            // `Arc<dyn CredentialStoreApi>` and `Store::new` answers
            // `Arc<Store>`, so the unsizing needs an argument position to happen
            // at.
            .map(|store| keyring_core::set_default_store(store))
            .map_err(|e| format!("no credential store: {e}"))
    })
    .unwrap_or_else(|_| Err("the Android credential store could not be reached".to_string()))
}

/* The control-plane credential, which is the only secret this app has. Thin
 * wrappers rather than the trait at every call site, because the commands read
 * better for it and the seam is still one type away.
 *
 * `scope` is an **account** — `<origin>#<user id>` — or, for an entry written
 * before accounts existed and not yet attributed to anybody, the bare origin
 * (`accounts.rs` has the rule). It is never something the page supplied: the
 * host derives it from the webview that asked. */

pub fn read(scope: &str) -> Option<String> {
    PlatformStore.read(CREDENTIAL, scope)
}

pub fn write(scope: &str, value: &str) -> Result<(), String> {
    PlatformStore.write(CREDENTIAL, scope, value)
}

pub fn erase(scope: &str) -> Result<(), String> {
    PlatformStore.erase(CREDENTIAL, scope)
}

/* The device key. Same store, same scoping, and deliberately the same three
 * verbs — `device.rs` owns every decision about what the value means. */

pub fn read_device_key(scope: &str) -> Option<String> {
    PlatformStore.read(DEVICE_KEY, scope)
}

pub fn write_device_key(scope: &str, value: &str) -> Result<(), String> {
    PlatformStore.write(DEVICE_KEY, scope, value)
}

pub fn erase_device_key(scope: &str) -> Result<(), String> {
    PlatformStore.erase(DEVICE_KEY, scope)
}

/// Whether this machine's store actually keeps what it is given.
///
/// **A probe, never a `cfg!`.** macOS and Windows always have a store; a Linux
/// box may have no D-Bus session or no unlocked collection, and `keyring`'s
/// secret-service backend then fails at runtime on a build that compiled fine.
/// Worse, a store that *accepts* a write and loses it is the failure that reads
/// as working — so this writes a canary, reads it back, compares it and erases
/// it, and only a full round trip counts as durable.
///
/// What the app does with a `false` is say so, in the sentence `cp.ts` already
/// has for a browser with storage disabled: it still works for one session, it
/// just asks for the password again next time. One state, one sentence, from one
/// place — two spellings of one state is a defect this repository has shipped
/// before.
pub fn probe() -> bool {
    let store = PlatformStore;
    let canary = "reemoat-durability-probe";
    // A scope no origin can normalize to, so the probe can never collide with a
    // real server's entry: a normalized origin always carries its scheme, and this
    // has none. (`normalize_origin` would *accept* this string as input and answer
    // `https://probe.invalid`, which is a different value — that is the point.)
    let scope = "probe.invalid";
    if store.write(CREDENTIAL, scope, canary).is_err() {
        return false;
    }
    let round_tripped = store.read(CREDENTIAL, scope).as_deref() == Some(canary);
    let _ = store.erase(CREDENTIAL, scope);
    round_tripped
}

#[cfg(test)]
mod tests {
    use super::account_for;

    #[test]
    fn the_scope_is_the_key() {
        assert_eq!(
            account_for("credential", "https://a.example"),
            "credential#https://a.example"
        );
        assert_ne!(
            account_for("credential", "https://a.example"),
            account_for("credential", "https://b.example")
        );
        // The scheme is part of the identity, so these are two entries.
        assert_ne!(
            account_for("credential", "http://a.example"),
            account_for("credential", "https://a.example")
        );
        // The account extension: two people on one server are two entries, and
        // neither is the bare, pre-accounts one.
        assert_eq!(
            account_for("credential", "https://a.example#u_1"),
            "credential#https://a.example#u_1"
        );
        assert_ne!(
            account_for("credential", "https://a.example#u_1"),
            account_for("credential", "https://a.example#u_2")
        );
        assert_ne!(
            account_for("credential", "https://a.example#u_1"),
            account_for("credential", "https://a.example")
        );
    }
}
