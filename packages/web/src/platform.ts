// The client's OS vocabulary (Rust's), not the daemon's `SystemInfo.os` (Node's): they share only `linux`, so never cross them.

export type HostPlatform = "macos" | "windows" | "linux" | "other";

export function hostPlatform(raw: string | null | undefined): HostPlatform {
  switch (raw) {
    case "macos":
      return "macos";
    case "windows":
      return "windows";
    case "linux":
      return "linux";
    default:
      return "other";
  }
}

/** Only the macOS arm names a remedy: nothing has been measured elsewhere. The caller appends `LOGS_POINTER`. */
export function localNetworkDetail(platform: HostPlatform): string {
  switch (platform) {
    case "macos":
      return (
        "macOS is not letting Reemoat reach servers on this network, so the daemon could not sign in. " +
        "Allow it under System Settings → Privacy & Security → Local Network, then reopen Reemoat."
      );
    case "windows":
    case "linux":
    case "other":
      return (
        "This computer refused the connection to the server's network, so the daemon could not sign in. " +
        "Nothing is down and waiting will not help."
      );
    default: {
      const exhaustive: never = platform;
      return exhaustive;
    }
  }
}

export function platformName(raw: string): string {
  const platform = hostPlatform(raw);
  switch (platform) {
    case "macos":
      return "macOS";
    case "windows":
      return "Windows";
    case "linux":
      return "Linux";
    case "other":
      return raw;
    default: {
      const exhaustive: never = platform;
      return exhaustive;
    }
  }
}
