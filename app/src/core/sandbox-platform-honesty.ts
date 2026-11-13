/**
 * Cross-platform sandbox honesty (docs/33 §5.3).
 *
 * Linux builds never claim macOS Seatbelt or macOS-only child_net; macOS builds
 * never claim Linux `hz-sandbox-exec` Landlock/netns as enforced here.
 */

export type SandboxPlatformHonesty = {
  /** Short line for doctor / notices — never claims enforcement. */
  detail: string;
  /** Additive `sandbox.report` platformNotes entries (kernel mirrors on wire). */
  platformNotes: string[];
};

export function sandboxPlatformHonesty(): SandboxPlatformHonesty {
  if (process.platform === "darwin") {
    return {
      detail:
        "macOS host — Linux hz-sandbox-exec (Landlock/userns+netns) is not in this binary; Seatbelt child_net is not wired",
      platformNotes: [
        "Linux hz-sandbox-exec confinement is unavailable in macOS-target builds; never reported as enforced.",
        "Seatbelt / macOS child_net backends are not implemented; never reported as enforced.",
      ],
    };
  }
  if (process.platform === "linux") {
    return {
      detail:
        "Linux build — macOS Seatbelt and macOS-only child_net confinement are not built into this binary",
      platformNotes: [
        "macOS Seatbelt and macOS child_net confinement are unavailable on Linux builds; never reported as enforced.",
      ],
    };
  }
  return {
    detail: `host OS ${process.platform} — platform-specific sandboxes (Seatbelt, hz-sandbox-exec) are not claimed enforced`,
    platformNotes: [
      "Platform-specific OS sandboxes (Seatbelt on macOS, hz-sandbox-exec on Linux) are not claimed enforced on this host OS.",
    ],
  };
}
