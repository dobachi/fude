//! updater_env.rs - Can an in-app update actually finish in this environment?
//!
//! On Linux deb/rpm installs the updater plugin escalates privileges in this order:
//!   1. `pkexec dpkg -i …`
//!   2. `zenity`/`kdialog` password prompt piped into `sudo -S dpkg -i …`
//!   3. terminal `sudo dpkg -i …`
//!
//! WSL has no logind session, so polkit can never authenticate. Step 1 finds no
//! authentication agent and asks for the password *on the console* before failing,
//! then step 2 asks again *in a GUI dialog*. The user is prompted twice and the
//! install fails regardless. There is nothing to retry, so we detect the situation
//! up front and let the frontend send the user to the release page instead.
//!
//! The package format check uses the same `bundle_type()` the updater plugin uses —
//! a value patched into the binary at bundle time. Unbundled runs (`cargo run`,
//! `cargo test`) report Unknown, i.e. "no root needed", which is fine because
//! in-app updates are not used during development.

use serde::Serialize;
use std::sync::OnceLock;
use tauri::utils::config::BundleType;
use tauri::utils::platform::bundle_type;

/// Whether an in-app update can complete here (reported to the frontend).
#[derive(Debug, Serialize, PartialEq, Clone, Default)]
pub struct UpdateEnv {
    /// Applying the update needs root (Linux deb / rpm install).
    pub needs_root: bool,
    /// Privilege escalation cannot authenticate (WSL has no polkit session).
    pub no_auth: bool,
    /// The in-app update is expected to succeed; false means "guide to manual update".
    pub can_install: bool,
}

/// The decision itself (pure). Needing root without a way to authenticate is hopeless.
fn can_install(needs_root: bool, no_auth: bool) -> bool {
    !(needs_root && no_auth)
}

/// Is the running binary installed in a format whose update needs root?
fn needs_root_install() -> bool {
    matches!(bundle_type(), Some(BundleType::Deb) | Some(BundleType::Rpm))
}

/// Running under WSL? `WSL_DISTRO_NAME` is conclusive; otherwise look at the kernel.
fn looks_like_wsl(distro_env: Option<&str>, osrelease: &str) -> bool {
    if distro_env.map(|s| !s.trim().is_empty()).unwrap_or(false) {
        return true;
    }
    let lower = osrelease.to_ascii_lowercase();
    lower.contains("microsoft") || lower.contains("wsl")
}

/// WSL detection, resolved once per process.
fn is_wsl() -> bool {
    static IS_WSL: OnceLock<bool> = OnceLock::new();
    *IS_WSL.get_or_init(|| {
        let distro = std::env::var("WSL_DISTRO_NAME").unwrap_or_default();
        let osrelease = std::fs::read_to_string("/proc/sys/kernel/osrelease").unwrap_or_default();
        looks_like_wsl(Some(&distro), &osrelease)
    })
}

/// Report whether the in-app update can finish. Used to pick the dialog's action.
#[tauri::command]
pub fn update_env() -> UpdateEnv {
    let needs_root = needs_root_install();
    let no_auth = is_wsl();
    UpdateEnv {
        needs_root,
        no_auth,
        can_install: can_install(needs_root, no_auth),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn can_install_only_fails_when_root_is_needed_and_unauthenticable() {
        assert!(!can_install(true, true)); // WSL + deb/rpm: the one broken combination
        assert!(can_install(true, false)); // ordinary Linux desktop (polkit works)
        assert!(can_install(false, true)); // WSL, but AppImage needs no root
        assert!(can_install(false, false)); // Windows / macOS
    }

    #[test]
    fn looks_like_wsl_uses_distro_env_first() {
        assert!(looks_like_wsl(Some("Ubuntu"), "5.15.0-generic"));
        assert!(!looks_like_wsl(Some("  "), "5.15.0-generic"));
        assert!(!looks_like_wsl(None, "5.15.0-generic"));
    }

    #[test]
    fn looks_like_wsl_falls_back_to_osrelease() {
        assert!(looks_like_wsl(None, "6.18.33.2-microsoft-standard-WSL2"));
        assert!(looks_like_wsl(Some(""), "4.4.0-19041-Microsoft")); // WSL1
    }

    #[test]
    fn update_env_is_consistent_with_its_flags() {
        let env = update_env();
        assert_eq!(env.can_install, can_install(env.needs_root, env.no_auth));
    }

    // Unbundled runs (cargo test) have no bundle type, so nothing needs root.
    #[test]
    fn unbundled_binary_does_not_need_root() {
        assert!(!needs_root_install());
    }
}
