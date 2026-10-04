// Everything lives in `lib.rs`: mobile targets build the library and call `run()` from a generated shim.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    reemoat_native_lib::run()
}
