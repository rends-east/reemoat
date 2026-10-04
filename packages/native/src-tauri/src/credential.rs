//! Secrets at rest, keyed on the account (`<origin>#<user id>`), since one webview origin serves
//! every server (Q1.651). The host decides the account, never the page.

// `keyring`'s `v1` refuses Android at run time, so that arm reaches past it to `keyring-core`.
// Aliased so `PlatformStore` is one body over either `Entry`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use keyring::{Entry, Error as StoreError};
#[cfg(target_os = "android")]
use keyring_core::{Entry, Error as StoreError};

const SERVICE: &str = "com.reemoat.app";

/// The device id is not a secret here: a store that discards writes would re-register it every launch.
pub const CREDENTIAL: &str = "credential";

pub const DEVICE_KEY: &str = "device_key";

/// No `list`, deliberately. The device key uses `read` (no Secure Enclave X25519): the page cannot read it, this process can.
pub trait SecretStore {
    fn read(&self, key: &str, scope: &str) -> Option<String>;
    fn write(&self, key: &str, scope: &str, value: &str) -> Result<(), String>;
    fn erase(&self, key: &str, scope: &str) -> Result<(), String>;
}

/// `v1` compiles for iOS and refuses at run time, so the build is refused here instead. Delete
/// this when writing the `apple-native-keyring-store` arm, in the same change.
#[cfg(target_os = "ios")]
compile_error!(
    "keyring's `v1` feature has no credential store on iOS or Android: it compiles \
     and then refuses at run time, so this build would never keep a sign-in. Write \
     the mobile `SecretStore` arm (keyring-core + apple-native-keyring-store / \
     android-native-keyring-store) and delete this refusal in the same change."
);

pub struct PlatformStore;

impl SecretStore for PlatformStore {
    fn read(&self, key: &str, scope: &str) -> Option<String> {
        let entry = entry(&account_for(key, scope)).ok()?;
        match entry.get_password() {
            Ok(value) if !value.is_empty() => Some(value),
            // Absent, locked or failing all mean "ask for the password again".
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
            Err(StoreError::NoEntry) => Ok(()),
            Err(e) => Err(format!("could not clear the sign-in: {e}")),
        }
    }
}

/// `#` needs no escaping: no origin and no user id (`accounts::is_user_id`) can carry one.
fn account_for(key: &str, scope: &str) -> String {
    format!("{key}#{scope}")
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| format!("no credential store: {e}"))
}

/// From `MainActivity.onCreate`, before Tauri's `setup`: nothing else sets `ndk-context` or
/// initialises `rustls-platform-verifier`, and both panic unset. One `catch_unwind` per half, so
/// an abort in the store's half cannot take the TLS one with it.
///
/// # Safety
/// Called by the JVM. Nulls are refused here; both halves are idempotent.
#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_reemoat_app_MainActivity_initNdkContext(
    env: jni::JNIEnv,
    _class: jni::objects::JObject,
    context: jni::objects::JObject,
) {
    // `jni` 0.21's `new_global_ref` keeps a null and 0.22's `from_raw` asserts on one, so check here.
    let raw_env = env.get_raw();
    let raw_context = context.as_raw();
    if raw_env.is_null() || raw_context.is_null() {
        return;
    }
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        adopt_context(&env, &context);
    }));
    // Through `jni` 0.22: the `jobject` cast is an identity, only the `JNIEnv` pointer changes shape.
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

/// Caches the attempt, not the success: the context is set once per process by contract.
#[cfg(target_os = "android")]
fn adopt_context(env: &jni::JNIEnv<'_>, context: &jni::objects::JObject<'_>) {
    use std::sync::OnceLock;
    // A local reference dies when `onCreate` returns.
    static HELD: OnceLock<Option<jni::objects::GlobalRef>> = OnceLock::new();
    HELD.get_or_init(|| {
        let Ok(held) = env.new_global_ref(context) else {
            return None;
        };
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

/// Caches only the success, so an `Err` from before `initNdkContext` is retried; the `Mutex`
/// serialises a burst of callers into one attempt.
#[cfg(target_os = "android")]
fn entry(account: &str) -> Result<Entry, String> {
    use std::sync::{Mutex, OnceLock};

    static READY: OnceLock<()> = OnceLock::new();
    static ATTEMPT: Mutex<()> = Mutex::new(());

    if READY.get().is_none() {
        let _serialized = ATTEMPT
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if READY.get().is_none() {
            install_default_store()?;
            let _ = READY.set(());
        }
    }
    Entry::new(SERVICE, account).map_err(|e| format!("no credential store: {e}"))
}

/// `catch_unwind`: the layer below panics when the context was never set, and an unreachable store
/// is a degraded mode, not an abort. Safe to call again: the vault lookup reuses a matching store.
#[cfg(target_os = "android")]
fn install_default_store() -> Result<(), String> {
    std::panic::catch_unwind(|| {
        android_native_keyring_store::Store::new()
            // A closure so `Arc<Store>` can unsize to `Arc<dyn CredentialStoreApi>`.
            .map(|store| keyring_core::set_default_store(store))
            .map_err(|e| format!("no credential store: {e}"))
    })
    .unwrap_or_else(|_| Err("the Android credential store could not be reached".to_string()))
}

// `scope` is an account, or the bare origin for a pre-accounts entry; never supplied by the page.

pub fn read(scope: &str) -> Option<String> {
    PlatformStore.read(CREDENTIAL, scope)
}

pub fn write(scope: &str, value: &str) -> Result<(), String> {
    PlatformStore.write(CREDENTIAL, scope, value)
}

pub fn erase(scope: &str) -> Result<(), String> {
    PlatformStore.erase(CREDENTIAL, scope)
}


pub fn read_device_key(scope: &str) -> Option<String> {
    PlatformStore.read(DEVICE_KEY, scope)
}

pub fn write_device_key(scope: &str, value: &str) -> Result<(), String> {
    PlatformStore.write(DEVICE_KEY, scope, value)
}

pub fn erase_device_key(scope: &str) -> Result<(), String> {
    PlatformStore.erase(DEVICE_KEY, scope)
}

/// A round trip, never a `cfg!`: a store with no unlocked collection accepts a write and loses it.
pub fn probe() -> bool {
    let store = PlatformStore;
    let canary = "reemoat-durability-probe";
    // Schemeless, so no normalized origin can equal it.
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
        assert_ne!(
            account_for("credential", "http://a.example"),
            account_for("credential", "https://a.example")
        );
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
