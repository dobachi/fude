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
#[cfg(test)]
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

/// A line a `Host` block should contain. `keys` are lowercase keyword
/// prefixes: when the block already has a line starting with any of them,
/// the user's setting stands and nothing is added.
#[derive(Debug, Clone)]
pub struct Want {
    pub keys: Vec<String>,
    pub lines: Vec<String>,
}

/// Connection sharing for the host: every `ssh` to it rides one connection,
/// which also owns the forward and outlives the session that opened it.
/// Without this only the first of several sessions gets the forward (the
/// remote port is taken), and closing that one cuts the others off.
pub fn sharing_want() -> Want {
    Want {
        keys: vec![
            "controlmaster".into(),
            "controlpath".into(),
            "controlpersist".into(),
        ],
        lines: vec![
            "ControlMaster auto".into(),
            "ControlPath ~/.ssh/fude-%C".into(),
            "ControlPersist 10m".into(),
        ],
    }
}

pub fn forward_want(port: u16, target: &str) -> Want {
    Want {
        keys: vec![format!("remoteforward {}", port)],
        lines: vec![forward_line(port, target)],
    }
}

fn has_key(line: &str, key: &str) -> bool {
    let t = line.trim_start().to_ascii_lowercase();
    match t.strip_prefix(key) {
        Some(rest) => rest.is_empty() || rest.starts_with([' ', '\t', '=']),
        None => false,
    }
}

/// Return `config` with every `want` satisfied in `host`'s block, plus the
/// lines that had to be added and whether a new block was appended.
///
/// A `Host` line whose patterns include `host` exactly gets the lines
/// inserted right after it (keeping the block's indentation); otherwise a
/// new block is appended.
pub fn ensure_host_lines(config: &str, host: &str, wants: &[Want]) -> (String, Vec<String>, bool) {
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
        let added: Vec<String> = wants.iter().flat_map(|w| w.lines.clone()).collect();
        let mut out = config.to_string();
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&format!(
            "# Fude: `fude-cli` on {host} opens files in this machine's Fude (fude setup)\nHost {host}\n"
        ));
        for l in &added {
            out.push_str(&format!("  {}\n", l));
        }
        return (out, added, true);
    };
    let end = lines[start + 1..]
        .iter()
        .position(|l| is_host_line(l) || l.trim_start().to_ascii_lowercase().starts_with("match "))
        .map(|i| start + 1 + i)
        .unwrap_or(lines.len());
    let block = &lines[start + 1..end];
    let added: Vec<String> = wants
        .iter()
        .filter(|w| !block.iter().any(|l| w.keys.iter().any(|k| has_key(l, k))))
        .flat_map(|w| w.lines.clone())
        .collect();
    if added.is_empty() {
        return (config.to_string(), added, false);
    }
    let indent = block
        .iter()
        .find(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
        .map(|l| &l[..l.len() - l.trim_start().len()])
        .unwrap_or("  ");
    let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    for (n, l) in added.iter().enumerate() {
        out.insert(start + 1 + n, format!("{}{}", indent, l));
    }
    let mut text = out.join("\n");
    if config.ends_with('\n') {
        text.push('\n');
    }
    (text, added, false)
}

/// The names `tailscale ssh <host>` hands to ssh for `host`, from
/// `tailscale status --json`.
///
/// `tailscale ssh k16` runs `ssh … user@k16.<tailnet>.` — the MagicDNS name,
/// trailing dot included — so a `Host k16` block does not apply to it and the
/// session would come up without the forward. Both spellings are returned;
/// `host` itself never is.
pub fn tailscale_names(status_json: &str, host: &str) -> Vec<String> {
    let Some(peer) = tailscale_peer(status_json, host) else {
        return Vec::new();
    };
    [peer.fqdn.clone(), format!("{}.", peer.fqdn)]
        .into_iter()
        .filter(|n| n != host)
        .collect()
}

/// A machine on the tailnet, as `tailscale status --json` describes it.
#[derive(Debug, Clone, PartialEq)]
pub struct TsPeer {
    /// MagicDNS name, without the trailing dot.
    pub fqdn: String,
    /// Tailnet addresses, as listed (IPv4 first in practice).
    pub ips: Vec<String>,
}

/// The tailnet peer that `host` names: by short name, MagicDNS name or
/// machine name, ignoring case.
pub fn tailscale_peer(status_json: &str, host: &str) -> Option<TsPeer> {
    let v = serde_json::from_str::<serde_json::Value>(status_json).ok()?;
    let peers = v.get("Peer").and_then(|p| p.as_object())?;
    let want = host.trim_end_matches('.').to_ascii_lowercase();
    for peer in peers.values() {
        let dns = peer.get("DNSName").and_then(|d| d.as_str()).unwrap_or("");
        let fqdn = dns.trim_end_matches('.');
        if fqdn.is_empty() {
            continue;
        }
        let short = fqdn.split('.').next().unwrap_or("").to_ascii_lowercase();
        let name = peer.get("HostName").and_then(|d| d.as_str()).unwrap_or("");
        if short == want || fqdn.eq_ignore_ascii_case(&want) || name.eq_ignore_ascii_case(&want) {
            let ips = peer
                .get("TailscaleIPs")
                .and_then(|i| i.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|ip| ip.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            return Some(TsPeer {
                fqdn: fqdn.to_string(),
                ips,
            });
        }
    }
    None
}

/// The `HostName` to write for a host ssh cannot find by itself, or `None`
/// when ssh is fine as it is.
///
/// `effective` is what ssh would connect to (`ssh -G`). A machine can be on
/// the tailnet while its short name does not resolve — no search domain, or
/// MagicDNS switched off, as in a WSL distribution that keeps its own
/// resolv.conf. The MagicDNS name is preferred; the address is the fallback
/// when DNS knows neither.
pub fn hostname_fix(
    effective: &str,
    peer: Option<&TsPeer>,
    resolves: impl Fn(&str) -> bool,
) -> Option<String> {
    if resolves(effective) {
        return None;
    }
    let peer = peer?;
    if resolves(&peer.fqdn) {
        return Some(peer.fqdn.clone());
    }
    peer.ips
        .iter()
        .find(|ip| !ip.contains(':'))
        .or(peer.ips.first())
        .cloned()
}

pub fn hostname_want(address: &str) -> Want {
    Want {
        keys: vec!["hostname".into()],
        lines: vec![format!("HostName {}", address)],
    }
}

/// The `hostname` line of `ssh -G` output: where ssh would really connect.
pub fn effective_hostname(ssh_g: &str) -> Option<String> {
    ssh_g.lines().find_map(|l| {
        let (key, value) = l.trim().split_once(' ')?;
        (key.eq_ignore_ascii_case("hostname") && !value.trim().is_empty())
            .then(|| value.trim().to_string())
    })
}

/// What to tell the user when ssh's own error says the name is unknown.
pub fn unresolved_hint(error: &str, host: &str) -> Option<String> {
    error
        .to_ascii_lowercase()
        .contains("could not resolve hostname")
        .then(|| {
            format!(
                "ssh on this machine does not know `{host}`. Use a name or address that `ssh` \
                 reaches from here, or add `HostName <address>` under `Host {host}` in \
                 ~/.ssh/config."
            )
        })
}

/// Like [`ensure_host_lines`], for a set of names that mean one machine: an
/// existing block for the first name is completed; otherwise one block
/// listing all of them is appended.
pub fn ensure_alias_lines(
    config: &str,
    aliases: &[String],
    wants: &[Want],
) -> (String, Vec<String>, bool) {
    let Some(first) = aliases.first() else {
        return (config.to_string(), Vec::new(), false);
    };
    let (text, added, appended) = ensure_host_lines(config, first, wants);
    if !appended || aliases.len() == 1 {
        return (text, added, appended);
    }
    // The block was just appended, so its header is the last such line.
    let header = format!("\nHost {}\n", first);
    let text = match text.rfind(&header) {
        Some(i) => format!(
            "{}\nHost {}\n{}",
            &text[..i],
            aliases.join(" "),
            &text[i + header.len()..]
        ),
        None => text,
    };
    (text, added, appended)
}

fn tailscale_status() -> Option<String> {
    // Inside WSL the tailnet may belong to Windows; its client answers too.
    ["tailscale", "tailscale.exe"].iter().find_map(|program| {
        let out = Command::new(program)
            .args(["status", "--json"])
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).to_string())
    })
}

fn resolves(name: &str) -> bool {
    use std::net::ToSocketAddrs;
    (name, 22)
        .to_socket_addrs()
        .is_ok_and(|mut a| a.next().is_some())
}

/// Where ssh would connect for `host`, per the config as it stands.
fn ssh_effective_hostname(host: &str) -> Option<String> {
    let out = Command::new("ssh")
        .args(["-G", host])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    effective_hostname(&String::from_utf8_lossy(&out.stdout))
}

/// Return `config` with the forward for `host` in place. An existing
/// `RemoteForward <port> …` in that block is left alone, whatever it points
/// at, since the user may have moved the socket on purpose.
#[cfg(test)]
pub fn with_forward(
    config: &str,
    host: &str,
    port: u16,
    local_socket: &str,
) -> (String, ConfigChange) {
    let (text, added, appended) =
        ensure_host_lines(config, host, &[forward_want(port, local_socket)]);
    let change = if appended {
        ConfigChange::AppendedBlock
    } else if added.is_empty() {
        ConfigChange::Unchanged
    } else {
        ConfigChange::AddedToBlock
    };
    (text, change)
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

/// What the remote's loopback port is forwarded to on this machine: the
/// GUI's socket where ssh can reach one, its loopback TCP port on Windows
/// (ssh cannot forward to a named pipe).
pub fn forward_target(config_dir: &Path) -> String {
    if cfg!(windows) {
        std::env::var("FUDE_GUI_TCP")
            .ok()
            .filter(|a| !a.trim().is_empty() && a != "off")
            .unwrap_or_else(|| format!("127.0.0.1:{}", DEFAULT_PORT))
    } else {
        fude_core::ipc::socket_path(config_dir)
            .to_string_lossy()
            .to_string()
    }
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

/// What a host is asked to find out which Fude its `fude-cli` reaches.
const REMOTE_CHECK: &str = "PATH=\"$HOME/.local/bin:$PATH\" fude-cli --check";

/// `setup HOST --check`: change nothing, only report which Fude answers
/// `fude-cli` on `host`. Returns the exit code.
pub fn check(host: &str) -> i32 {
    if host.is_empty() || host.starts_with('-') {
        eprintln!("fude-cli setup: usage: fude-cli setup <ssh-host> --check");
        return 2;
    }
    match ssh(host, REMOTE_CHECK) {
        Ok(s) => {
            println!("{}", s);
            0
        }
        Err(e) => {
            eprintln!("fude-cli setup: {}", e);
            2
        }
    }
}

/// Run the whole setup. Returns the exit code.
pub fn run(host: &str, port: u16, share: bool) -> i32 {
    match run_inner(host, port, share) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("fude-cli setup: {}", e);
            2
        }
    }
}

fn run_inner(host: &str, port: u16, share: bool) -> Result<(), String> {
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
    let target = forward_target(&config_dir);
    let ssh_dir = dirs::home_dir()
        .ok_or("cannot find the home directory")?
        .join(".ssh");
    let cfg_path = ssh_dir.join("config");
    let existing = std::fs::read_to_string(&cfg_path).unwrap_or_default();
    // Windows' OpenSSH has no connection sharing; there the first session
    // keeps the forward.
    let mut wants = vec![forward_want(port, &target)];
    if share && !cfg!(windows) {
        wants.push(sharing_want());
    }
    let ts_status = tailscale_status();
    // On the tailnet but unknown to this machine's DNS: point ssh at it.
    let peer = ts_status.as_deref().and_then(|j| tailscale_peer(j, host));
    let effective = ssh_effective_hostname(host).unwrap_or_else(|| host.to_string());
    let mut host_wants = wants.clone();
    if let Some(address) = hostname_fix(&effective, peer.as_ref(), resolves) {
        host_wants.push(hostname_want(&address));
    }
    let (updated, host_added, appended) = ensure_host_lines(&existing, host, &host_wants);
    // `tailscale ssh <host>` reaches the same machine under another name.
    let ts_names = ts_status
        .map(|j| tailscale_names(&j, host))
        .unwrap_or_default();
    let (updated, ts_added, _) = ensure_alias_lines(&updated, &ts_names, &wants);
    let ts_changed = !ts_added.is_empty();
    let ts_only = host_added.is_empty() && ts_changed;
    let added = if ts_only { ts_added } else { host_added };
    if added.is_empty() {
        Step("ssh config").ok("already set up");
    } else {
        std::fs::create_dir_all(&ssh_dir).map_err(|e| e.to_string())?;
        if cfg_path.exists() {
            let bak = ssh_dir.join("config.fude-bak");
            std::fs::copy(&cfg_path, &bak).map_err(|e| e.to_string())?;
        }
        std::fs::write(&cfg_path, updated).map_err(|e| e.to_string())?;
        let _ = fude_core::paths::set_file_permissions(&cfg_path);
        Step("ssh config").ok(&format!(
            "{} (backup: config.fude-bak)",
            if ts_only {
                format!("appended `Host {}` for `tailscale ssh`", ts_names.join(" "))
            } else if appended {
                format!("appended `Host {}`", host)
            } else {
                format!("added to `Host {}`", host)
            }
        ));
        for l in &added {
            eprintln!("      {}", l);
        }
        if ts_changed && !ts_only {
            eprintln!(
                "    also for `tailscale ssh {}` (Host {})",
                host,
                ts_names.join(" ")
            );
        }
        if added.iter().any(|l| l.starts_with("ControlMaster")) {
            eprintln!(
                "    ssh sessions to {} now share one connection, so each of them reaches Fude \
                 (`ssh -O exit {}` closes it; `fude setup {} --no-share` leaves ssh alone).",
                host, host, host
            );
        }
    }

    // 3. remote side
    let uname = ssh(
        host,
        "mkdir -p ~/.config/fude ~/.local/bin && uname -sm && (echo $PATH | tr : '\\n' | grep -qx \"$HOME/.local/bin\" && echo PATH_OK || echo PATH_MISSING)",
    )
    .map_err(|e| match unresolved_hint(&e, host) {
        Some(hint) => format!("{}\n  {}", e, hint),
        None => e,
    })?;
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
    let check = ssh(host, REMOTE_CHECK);
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
    fn sharing_is_added_once_and_respects_existing_settings() {
        let wants = [forward_want(47821, SOCK), sharing_want()];
        let (out, added, appended) = ensure_host_lines("Host k16\n  User u\n", "k16", &wants);
        assert!(!appended);
        assert_eq!(added.len(), 4);
        assert_eq!(
            out,
            "Host k16\n  RemoteForward 47821 /home/u/.config/fude/gui.sock\n  ControlMaster auto\n  ControlPath ~/.ssh/fude-%C\n  ControlPersist 10m\n  User u\n"
        );
        // Idempotent.
        let (again, added, _) = ensure_host_lines(&out, "k16", &wants);
        assert!(added.is_empty());
        assert_eq!(again, out);

        // The user already manages sharing for this host: only the forward.
        let cfg = "Host k16\n  controlpath /tmp/x\n";
        let (out, added, _) = ensure_host_lines(cfg, "k16", &wants);
        assert_eq!(
            added,
            vec!["RemoteForward 47821 /home/u/.config/fude/gui.sock"]
        );
        assert!(!out.contains("ControlMaster"));

        // No block yet: everything goes into the new one.
        let (out, added, appended) = ensure_host_lines("", "new", &wants);
        assert!(appended);
        assert_eq!(added.len(), 4);
        assert!(out.ends_with("  ControlPersist 10m\n"));

        // A keyword that merely shares a prefix does not count.
        assert!(!has_key("  ControlPathological x", "controlpath"));
        assert!(has_key("ControlPath=/x", "controlpath"));
    }

    #[test]
    fn non_ascii_comments_do_not_break_parsing() {
        let cfg = "#サブアカウント\nHost github-x\n  User git\n# ホスト\nHost k16\n  User u\n";
        let (out, c) = with_forward(cfg, "k16", 47821, SOCK);
        assert_eq!(c, ConfigChange::AddedToBlock);
        assert!(out.contains("Host k16\n  RemoteForward 47821"));
        assert!(out.starts_with("#サブアカウント\n"));
    }

    #[cfg(unix)]
    #[test]
    fn the_forward_targets_the_gui_socket_on_unix() {
        let _env = crate::discover::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        std::env::remove_var(fude_core::ipc::SOCKET_ENV);
        assert_eq!(forward_target(Path::new("/c")), "/c/gui.sock");
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

    const TS: &str = r#"{"Self":{"HostName":"me","DNSName":"me.tail.example.net."},
        "Peer":{"nodekey:a":{"HostName":"K16","DNSName":"k16.tail.example.net."},
                "nodekey:b":{"HostName":"other","DNSName":"k16x.tail.example.net."},
                "nodekey:c":{"HostName":"nodns","DNSName":""}}}"#;

    #[test]
    fn tailscale_names_are_the_magicdns_name_with_and_without_the_dot() {
        let both = vec![
            "k16.tail.example.net".to_string(),
            "k16.tail.example.net.".to_string(),
        ];
        assert_eq!(tailscale_names(TS, "k16"), both);
        assert_eq!(tailscale_names(TS, "K16"), both);
        // Asked by the full name: only the other spelling is new.
        assert_eq!(
            tailscale_names(TS, "k16.tail.example.net"),
            vec!["k16.tail.example.net.".to_string()]
        );
        // A prefix is not a match, nor is a peer without a name.
        assert_eq!(tailscale_names(TS, "k1"), Vec::<String>::new());
        assert_eq!(tailscale_names(TS, "nodns"), Vec::<String>::new());
        assert_eq!(tailscale_names(TS, "unknown"), Vec::<String>::new());
        assert_eq!(tailscale_names("not json", "k16"), Vec::<String>::new());
        assert_eq!(tailscale_names("{}", "k16"), Vec::<String>::new());
    }

    const TS_IPS: &str = r#"{"Peer":{
        "a":{"HostName":"k16","DNSName":"k16.tail.example.net.","TailscaleIPs":["100.64.0.1","fd7a::1"]},
        "b":{"HostName":"six","DNSName":"six.tail.example.net.","TailscaleIPs":["fd7a::2"]},
        "c":{"HostName":"bare","DNSName":"bare.tail.example.net."}}}"#;

    #[test]
    fn tailscale_peer_carries_the_name_and_addresses() {
        let k16 = tailscale_peer(TS_IPS, "K16").unwrap();
        assert_eq!(k16.fqdn, "k16.tail.example.net");
        assert_eq!(k16.ips, ["100.64.0.1", "fd7a::1"]);
        assert_eq!(
            tailscale_peer(TS_IPS, "bare").unwrap().ips,
            Vec::<String>::new()
        );
        assert_eq!(tailscale_peer(TS_IPS, "k1"), None);
        assert_eq!(tailscale_peer("not json", "k16"), None);
    }

    #[test]
    fn a_host_ssh_cannot_find_gets_its_tailnet_name_or_address() {
        let k16 = tailscale_peer(TS_IPS, "k16");
        // Resolves already: ssh is left alone, tailnet or not.
        assert_eq!(hostname_fix("k16", k16.as_ref(), |_| true), None);
        // The short name fails but MagicDNS answers the full one.
        assert_eq!(
            hostname_fix("k16", k16.as_ref(), |n| n.contains('.')),
            Some("k16.tail.example.net".into())
        );
        // DNS knows nothing of the tailnet: the IPv4 address.
        assert_eq!(
            hostname_fix("k16", k16.as_ref(), |_| false),
            Some("100.64.0.1".into())
        );
        // Only IPv6 listed: better than nothing.
        let six = tailscale_peer(TS_IPS, "six");
        assert_eq!(
            hostname_fix("six", six.as_ref(), |_| false),
            Some("fd7a::2".into())
        );
        // No address at all, or not on the tailnet: nothing to offer.
        let bare = tailscale_peer(TS_IPS, "bare");
        assert_eq!(hostname_fix("bare", bare.as_ref(), |_| false), None);
        assert_eq!(hostname_fix("nope", None, |_| false), None);
    }

    #[test]
    fn the_hostname_goes_into_the_block_once_and_never_over_the_users() {
        let wants = [forward_want(47821, SOCK), hostname_want("100.64.0.1")];
        // A block left by an earlier, failed run gains just the HostName.
        let cfg = format!("Host k16\n  {}\n", forward_line(47821, SOCK));
        let (out, added, appended) = ensure_host_lines(&cfg, "k16", &wants);
        assert_eq!(added, ["HostName 100.64.0.1"]);
        assert!(!appended);
        assert!(out.starts_with("Host k16\n  HostName 100.64.0.1\n"));
        let (again, added, _) = ensure_host_lines(&out, "k16", &wants);
        assert!(added.is_empty());
        assert_eq!(again, out);
        // The user's own HostName stays, whatever it says.
        let cfg = "Host k16\n  hostname gone.example\n";
        let (out, added, _) = ensure_host_lines(cfg, "k16", &wants);
        assert_eq!(added, [forward_line(47821, SOCK)]);
        assert!(!out.contains("100.64.0.1"));
    }

    #[test]
    fn effective_hostname_reads_ssh_g() {
        assert_eq!(
            effective_hostname("user u\nhostname 10.0.0.1\nport 22\n"),
            Some("10.0.0.1".into())
        );
        assert_eq!(effective_hostname("user u\nhostnamex y\n"), None);
        assert_eq!(effective_hostname(""), None);
    }

    #[test]
    fn an_unknown_name_is_explained() {
        let e = "ssh k16 failed: ssh: Could not resolve hostname k16: Name or service not known";
        let hint = unresolved_hint(e, "k16").unwrap();
        assert!(hint.contains("HostName <address>") && hint.contains("Host k16"));
        assert!(!hint.contains("  "), "one line, single-spaced: {hint}");
        assert_eq!(
            unresolved_hint("ssh k16 failed: Permission denied", "k16"),
            None
        );
    }

    #[test]
    fn tailscale_names_get_one_block_and_are_not_added_twice() {
        let wants = [forward_want(47821, SOCK), sharing_want()];
        let names = tailscale_names(TS, "k16");
        let base = "Host k16\n  RemoteForward 47821 /home/u/.config/fude/gui.sock\n";
        let (out, added, appended) = ensure_alias_lines(base, &names, &wants);
        assert!(appended);
        assert_eq!(added.len(), 4);
        assert!(out.starts_with(base));
        assert!(out.contains(
            "\nHost k16.tail.example.net k16.tail.example.net.\n  RemoteForward 47821 /home/u/.config/fude/gui.sock\n  ControlMaster auto\n"
        ));
        assert_eq!(out.matches("Host k16.tail").count(), 1);

        let (again, added, appended) = ensure_alias_lines(&out, &names, &wants);
        assert_eq!(again, out);
        assert!(added.is_empty() && !appended);

        // No tailscale: nothing happens.
        let (same, added, appended) = ensure_alias_lines(base, &[], &wants);
        assert_eq!(same, base);
        assert!(added.is_empty() && !appended);
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
