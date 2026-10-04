use std::path::{Path, PathBuf};

/// Also in `build-daemon.mjs`, `tauri.conf.json` and `daemon.rs`; `nativecheck` compares all four.
const RUNTIME_HELPER: &str = "Reemoat Runtime.app";

fn main() {
    // `config.rs` bakes this in with `option_env!`; without the line a changed value never rebuilds.
    println!("cargo:rerun-if-env-changed=REEMOAT_DEFAULT_SERVER");
    runtime_helper();
    tauri_build::build()
}

/// Refuses a missing or wrong-architecture runtime by its Mach-O CPU type, since the bundler
/// copies whatever sits at the fixed path; copies it beside the profile dir when that is not `target`.
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
    // `<target>/<profile>/build/<crate>-<hash>/out`; cargo offers nothing better (rust-lang/cargo#5457).
    let Some(target) = out.ancestors().nth(4) else {
        return;
    };
    // Canonical, because the copy deletes its destination: a symlinked spelling would delete the source.
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

/// Byte-for-byte, which keeps the helper's signature valid.
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
