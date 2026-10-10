//! `fude-cli setup <ssh-host>`: everything a remote machine needs so that
//! `fude-cli notes.md` there opens in this machine's Fude.
//!
//! 1. the GUI token exists here (`~/.config/fude/gui-token`)
//! 2. `~/.ssh/config` forwards the remote's loopback port to the local socket
//! 3. the remote has `~/.config/fude/gui-token` and `~/.local/bin/fude-cli`
//!    (this very binary when the OS/arch match, else the Releases build)
//! 4. a handshake through the forward succeeds
//!
//! The ssh-config rewrite is pure (`with_forward`) so it can be tested; the
//! rest shells out to `ssh` / `scp`, which carry the user's keys and config.

use std::path::Path;
use std::process::Command;

pub const DEFAULT_PORT: u16 = 47821;
const RELEASES: &str = "https://github.com/dobachi/fude/releases/latest/download";

/// What `with_forward` did to the config text.
#[derive(Debug, PartialEq)]
pub enum ConfigChange {
    /// The forward was already there.
    Unchanged,
    /// Added the line to an existing `Host` block.
    AddedToBlock,
    /// Appended a whole new `Host` block.
    AppendedBlock,
}

/// The `RemoteForward` line for `host`.
fn forward_line(port: u16, local_socket: &str) -> String {
    format!("RemoteForward {} {}", port, local_socket)
}

/// Return `config` with the forward for `host` in place.
///
/// A `Host` line whose patterns include `host` exactly gets the forward
/// inserted right after it (keeping the block's indentation); otherwise a
/// new block is appended. An existing `RemoteForward <port> …` in that block
/// is left alone, whatever it points at, since the user may have moved the
/// socket on purpose.
pub fn with_forward(
    config: &str,
    host: &str,
    port: u16,
    local_socket: &str,
) -> (String, ConfigChange) {
    let lines: Vec<&str> = config.lines().collect();
    // Byte-safe: config comments may hold non-ASCII text, so never slice
    // at a fixed byte offset.
    let is_host_line = |l: &str| {
        let t = l.trim_start();
        t.get(..5)
            .map(|h| h.eq_ignore_ascii_case("host "))
            .unwrap_or(false)
    };
    let block_start = lines
        .iter()
        .position(|l| is_host_line(l) && l.trim_start()[5..].split_whitespace().any(|p| p == host));
    let Some(start) = block_start else {
        let mut out = config.to_string();
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&format!(
            "# Fude: `fude-cli` on {host} opens files in this machine's Fude (fude-cli setup)\nHost {host}\n  {}\n",
            forward_line(port, local_socket)
        ));
        return (out, ConfigChange::AppendedBlock);
    };
    let end = lines[start + 1..]
        .iter()
        .position(|l| is_host_line(l) || l.trim_start().to_ascii_lowercase().starts_with("match "))
        .map(|i| start + 1 + i)
        .unwrap_or(lines.len());
    let marker = format!("remoteforward {} ", port);
    if lines[start + 1..end].iter().any(|l| {
        let t = l.trim_start().to_ascii_lowercase();
        t.starts_with(&marker) || t == marker.trim_end()
    }) {
        return (config.to_string(), ConfigChange::Unchanged);
    }
    let indent = lines[start + 1..end]
        .iter()
        .find(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
        .map(|l| &l[..l.len() - l.trim_start().len()])
        .unwrap_or("  ");
    let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    out.insert(
        start + 1,
        format!("{}{}", indent, forward_line(port, local_socket)),
    );
    let mut text = out.join("\n");
    if config.ends_with('\n') {
        text.push('\n');
    }
    (text, ConfigChange::AddedToBlock)
}

/// `fude-cli-<os>-<arch>` as published on Releases, from `uname -sm` output.
pub fn release_asset(uname_sm: &str) -> Option<String> {
    let mut it = uname_sm.split_whitespace();
    let os = match it.next()? {
        "Linux" => "linux",
        "Darwin" => "macos",
        _ => return None,
    };
    let arch = it.next()?;
    Some(format!("fude-cli-{}-{}", os, arch))
}

/// This machine's `uname -sm` equivalent, for deciding whether our own
/// binary can simply be copied.
pub fn local_uname_sm() -> String {
    let os = match std::env::consts::OS {
        "linux" => "Linux",
        "macos" => "Darwin",
        "windows" => "Windows",
        o => o,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => {
            if os == "Darwin" {
                "arm64"
            } else {
                "aarch64"
            }
        }
        a => a,
    };
    format!("{} {}", os, arch)
}

struct Step<'a>(&'a str);
impl Step<'_> {
    fn ok(&self, detail: &str) {
        eprintln!("  ✓ {}: {}", self.0, detail);
    }
}

fn ssh(host: &str, cmd: &str) -> Result<String, String> {
    let out = Command::new("ssh")
        .args(["-o", "BatchMode=yes", host, cmd])
        .output()
        .map_err(|e| format!("cannot run ssh: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "ssh {} failed: {}",
            host,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn scp(src: &Path, host: &str, dest: &str) -> Result<(), String> {
    let out = Command::new("scp")
        .args(["-q", "-o", "BatchMode=yes"])
        .arg(src)
        .arg(format!("{}:{}", host, dest))
        .output()
        .map_err(|e| format!("cannot run scp: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "scp to {} failed: {}",
            host,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// Run the whole setup. Returns the exit code.
pub fn run(host: &str, port: u16) -> i32 {
    match run_inner(host, port) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("fude-cli setup: {}", e);
            2
        }
    }
}

fn run_inner(host: &str, port: u16) -> Result<(), String> {
    if host.is_empty() || host.starts_with('-') {
        return Err("usage: fude-cli setup <ssh-host>".into());
    }
    eprintln!("Setting up {} to open files in this machine's Fude", host);

    // 1. token
    let config_dir = fude_core::config_dir()?;
    let token_path = config_dir.join(fude_core::token::TOKEN_FILE);
    fude_core::token::load_or_create(&token_path)?;
    Step("token").ok(&token_path.display().to_string());

    // 2. ssh config
    let local_socket = fude_core::ipc::socket_path(&config_dir);
    let ssh_dir = dirs::home_dir()
        .ok_or("cannot find the home directory")?
        .join(".ssh");
    let cfg_path = ssh_dir.join("config");
    let existing = std::fs::read_to_string(&cfg_path).unwrap_or_default();
    let (updated, change) = with_forward(&existing, host, port, &local_socket.to_string_lossy());
    match change {
        ConfigChange::Unchanged => Step("ssh config").ok("forward already present"),
        _ => {
            std::fs::create_dir_all(&ssh_dir).map_err(|e| e.to_string())?;
            if cfg_path.exists() {
                let bak = ssh_dir.join("config.fude-bak");
                std::fs::copy(&cfg_path, &bak).map_err(|e| e.to_string())?;
            }
            std::fs::write(&cfg_path, updated).map_err(|e| e.to_string())?;
            let _ = fude_core::paths::set_file_permissions(&cfg_path);
            Step("ssh config").ok(&format!(
                "{} `RemoteForward {} …` (backup: config.fude-bak)",
                if change == ConfigChange::AddedToBlock {
                    "added"
                } else {
                    "appended block with"
                },
                port
            ));
        }
    }

    // 3. remote side
    let uname = ssh(
        host,
        "mkdir -p ~/.config/fude ~/.local/bin && uname -sm && (echo $PATH | tr : '\\n' | grep -qx \"$HOME/.local/bin\" && echo PATH_OK || echo PATH_MISSING)",
    )?;
    let mut lines = uname.lines();
    let remote_uname = lines.next().unwrap_or_default().to_string();
    let path_ok = lines.next() == Some("PATH_OK");
    Step("remote").ok(&format!("{} ({})", host, remote_uname));

    scp(&token_path, host, "~/.config/fude/gui-token")?;
    ssh(host, "chmod 600 ~/.config/fude/gui-token")?;
    Step("token copied").ok("~/.config/fude/gui-token");

    let local = local_uname_sm();
    if remote_uname == local {
        let me = std::env::current_exe().map_err(|e| e.to_string())?;
        scp(&me, host, "~/.local/bin/fude-cli")?;
        ssh(host, "chmod 755 ~/.local/bin/fude-cli")?;
        Step("fude-cli").ok("copied this binary (same OS/arch)");
    } else {
        let asset = release_asset(&remote_uname)
            .ok_or_else(|| format!("no fude-cli build for '{}'", remote_uname))?;
        let url = format!("{}/{}", RELEASES, asset);
        ssh(
            host,
            &format!(
                "curl -fsSL -o ~/.local/bin/fude-cli '{}' && chmod 755 ~/.local/bin/fude-cli",
                url
            ),
        )
        .map_err(|e| format!("{} (download {})", e, url))?;
        Step("fude-cli").ok(&format!("downloaded {}", asset));
    }

    // 4. verify through the forward (a fresh ssh picks up the new config)
    let check = ssh(host, "PATH=\"$HOME/.local/bin:$PATH\" fude-cli --check");
    match check {
        Ok(s) => Step("check").ok(&s),
        Err(e) => {
            eprintln!("  ✗ check: {}", e);
            eprintln!(
                "    Is Fude running on this machine? Start it and run: ssh {} fude-cli --check",
                host
            );
        }
    }

    eprintln!();
    eprintln!(
        "Done. On {}: `fude-cli notes.md` (or `fude-cli --wait` as $EDITOR).",
        host
    );
    if !path_ok {
        eprintln!("Note: ~/.local/bin is not on PATH there; add it or call ~/.local/bin/fude-cli.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOCK: &str = "/home/u/.config/fude/gui.sock";

    #[test]
    fn appends_a_block_when_the_host_is_unknown() {
        let (out, c) = with_forward("Host other\n  User x\n", "k16", 47821, SOCK);
        assert_eq!(c, ConfigChange::AppendedBlock);
        assert!(out.starts_with("Host other\n  User x\n\n# Fude"));
        assert!(out.ends_with("Host k16\n  RemoteForward 47821 /home/u/.config/fude/gui.sock\n"));
        let (out, c) = with_forward("", "k16", 47821, SOCK);
        assert_eq!(c, ConfigChange::AppendedBlock);
        assert!(out.starts_with("# Fude"));
    }

    #[test]
    fn inserts_into_an_existing_block_keeping_its_indent() {
        let cfg = "Host k16 k16b\n    HostName 10.0.0.1\n    User u\n\nHost other\n  User x\n";
        let (out, c) = with_forward(cfg, "k16", 47821, SOCK);
        assert_eq!(c, ConfigChange::AddedToBlock);
        assert_eq!(
            out,
            "Host k16 k16b\n    RemoteForward 47821 /home/u/.config/fude/gui.sock\n    HostName 10.0.0.1\n    User u\n\nHost other\n  User x\n"
        );
    }

    #[test]
    fn leaves_an_existing_forward_on_that_port_alone() {
        let cfg = "Host k16\n  remoteforward 47821 /elsewhere/gui.sock\n";
        let (out, c) = with_forward(cfg, "k16", 47821, SOCK);
        assert_eq!(c, ConfigChange::Unchanged);
        assert_eq!(out, cfg);
        // Same port forwarded in another host's block does not count.
        let cfg = "Host a\n  RemoteForward 47821 x\nHost k16\n  User u\n";
        let (_, c) = with_forward(cfg, "k16", 47821, SOCK);
        assert_eq!(c, ConfigChange::AddedToBlock);
    }

    #[test]
    fn non_ascii_comments_do_not_break_parsing() {
        let cfg = "#サブアカウント\nHost github-x\n  User git\n# ホスト\nHost k16\n  User u\n";
        let (out, c) = with_forward(cfg, "k16", 47821, SOCK);
        assert_eq!(c, ConfigChange::AddedToBlock);
        assert!(out.contains("Host k16\n  RemoteForward 47821"));
        assert!(out.starts_with("#サブアカウント\n"));
    }

    #[test]
    fn host_patterns_must_match_exactly() {
        let cfg = "Host k16x\n  User u\n";
        let (_, c) = with_forward(cfg, "k16", 47821, SOCK);
        assert_eq!(c, ConfigChange::AppendedBlock);
        let cfg = "host k16\n  User u\n";
        let (_, c) = with_forward(cfg, "k16", 47821, SOCK);
        assert_eq!(c, ConfigChange::AddedToBlock);
    }

    #[test]
    fn release_asset_names_follow_the_ci_convention() {
        assert_eq!(
            release_asset("Linux x86_64").as_deref(),
            Some("fude-cli-linux-x86_64")
        );
        assert_eq!(
            release_asset("Linux aarch64").as_deref(),
            Some("fude-cli-linux-aarch64")
        );
        assert_eq!(
            release_asset("Darwin arm64").as_deref(),
            Some("fude-cli-macos-arm64")
        );
        assert_eq!(release_asset("FreeBSD amd64"), None);
        assert_eq!(release_asset(""), None);
        assert!(local_uname_sm().contains(' '));
    }
}
