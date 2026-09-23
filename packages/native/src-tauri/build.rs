use std::path::{Path, PathBuf};

/// The helper app the runtime lives in on macOS.
///
/// Written down in `build-daemon.mjs`, `tauri.conf.json`'s `bundle.macOS.files` and
/// `daemon.rs` as well; `nativecheck` compares all four.
const RUNTIME_HELPER: &str = "Reemoat Runtime.app";

fn main() {
    /*
     * ⚠ **`option_env!` is baked into a cached object file, and this is what makes
     * a changed value rebuild.** `config.rs` reads `REEMOAT_DEFAULT_SERVER` at
     * compile time — the only moment a fork can say which fleet its build joins,
     * a bundle having no environment to read when Finder or a desktop entry
     * launches it. Without this line cargo has no reason to recompile when the
     * variable moves, so a fork that corrects its address gets a binary that
     * silently keeps the previous one, with nothing anywhere saying why.
     */
    println!("cargo:rerun-if-env-changed=REEMOAT_DEFAULT_SERVER");
    runtime_helper();
    tauri_build::build()
}

/// The staged runtime helper: refused if it is missing or built for the other
/// architecture, and put where the executable looks for it.
///
/// ⚠ **This is the check the runtime's file name used to make.** While the runtime
/// was an `externalBin`, `tauri-build` resolved `binaries/node-<target-triple>`, so a
/// build for one architecture staged for the other failed here with *"resource path
/// `binaries/node-x86_64-apple-darwin` doesn't exist"*. `bundle.macOS.files` names a
/// fixed path and the bundler copies whatever is there, so without this an Intel
/// build staged on an Apple-silicon machine would ship an arm64 `node` and start no
/// daemon on the machines it was built for. The binary is asked, not a marker file:
/// the Mach-O header's CPU type, which is what the kernel will ask.
///
/// ⚠ **And the copy is what `tauri-build` did for an `externalBin`.** A development
/// build finds the runtime at `<exe>/../../Helpers`, which is the staged helper
/// itself when the target directory is `src-tauri/target` — so nothing is copied in
/// the ordinary case — and a copy beside the profile directory when it is not: a
/// `--target` build, or `CARGO_TARGET_DIR` set elsewhere.
fn runtime_helper() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let manifest =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let staged = manifest.join("target").join("Helpers").join(RUNTIME_HELPER);
    let node = staged.join("Contents").join("MacOS").join("node");
    println!("cargo:rerun-if-changed={}", node.display());
    println!(
        "cargo:rerun-if-changed={}",
        staged.join("Contents").join("Info.plist").display()
    );

    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let (wanted, triple) = match arch.as_str() {
        "aarch64" => (0x0100_000c_u32, "aarch64-apple-darwin"),
        "x86_64" => (0x0100_0007_u32, "x86_64-apple-darwin"),
        other => panic!("no Node runtime is staged for a macOS build on {other}"),
    };
    let stage = format!("`node packages/native/scripts/build-daemon.mjs {triple}` (or `pnpm native:stage` on this architecture)");
    let found = match cpu_type(&node) {
        Ok(found) => found,
        Err(e) => panic!(
            "no runtime helper at {}: {e}. Stage it first with {stage}.",
            node.display()
        ),
    };
    if found != wanted {
        panic!(
            "the runtime staged at {} is for another architecture (Mach-O CPU type {found:#010x}) and this build is for {triple}. Restage with {stage}.",
            node.display()
        );
    }

    let out = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    // `<target>/<profile>/build/<crate>-<hash>/out`, which is how `tauri-build` finds
    // the profile directory too; cargo offers nothing better (rust-lang/cargo#5457).
    let Some(target) = out.ancestors().nth(4) else {
        return;
    };
    /*
     * ⚠ **Compared canonically, because the copy starts by deleting its
     * destination.** The two spellings of one directory — a symlinked
     * `CARGO_TARGET_DIR`, `/tmp` against `/private/tmp` — would otherwise read as
     * two places, and removing the "old copy" would remove the staged helper it was
     * about to copy from.
     */
    let same = match (
        std::fs::canonicalize(target),
        std::fs::canonicalize(manifest.join("target")),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if same {
        return;
    }
    let placed = target.join("Helpers").join(RUNTIME_HELPER);
    if placed.exists() {
        std::fs::remove_dir_all(&placed)
            .expect("the previous copy of the runtime helper can be removed");
    }
    copy_dir(&staged, &placed)
        .expect("the runtime helper can be copied beside the profile directory");
}

/// The CPU type of a thin 64-bit Mach-O, which is what every Node build for macOS is.
fn cpu_type(path: &Path) -> std::io::Result<u32> {
    use std::io::Read;
    let mut header = [0_u8; 8];
    std::fs::File::open(path)?.read_exact(&mut header)?;
    if header[..4] != [0xcf, 0xfa, 0xed, 0xfe] {
        return Err(std::io::Error::other("not a thin 64-bit Mach-O"));
    }
    Ok(u32::from_le_bytes([
        header[4], header[5], header[6], header[7],
    ]))
}

/// A byte-for-byte copy, which is what keeps the helper's signature valid.
fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}
