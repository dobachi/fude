//! The Fudes a host may open files in, one per machine that ran
//! `fude setup` against it.
//!
//! Each machine forwards its own loopback port and has its own token, kept
//! on the host in `~/.config/fude/guis/<port>` (the token, then the
//! machine's name). Two machines can then stay logged in at once without
//! taking each other's forward or overwriting each other's token — which is
//! what happened while every machine used port 47821 and the one
//! `gui-token` file.

use crate::discover::Candidate;
use std::path::{Path, PathBuf};

/// The first of the ports machines are spread over. 47821 stays what it
/// was: the port of setups made before machines had their own.
pub const FIRST_PORT: u16 = 47822;
const PORTS: u16 = 1000;

/// The port a machine forwards, derived from its token so that it is the
/// same on every run and (almost surely) differs between machines.
pub fn port_for(token: &str) -> u16 {
    // FNV-1a: std's hasher may change between Rust versions, and the port
    // is written into ~/.ssh/config.
    let mut h: u32 = 0x811c_9dc5;
    for b in token.trim().bytes() {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x0100_0193);
    }
    FIRST_PORT + (h % u32::from(PORTS)) as u16
}

/// One machine's entry on the host.
#[derive(Debug, Clone, PartialEq)]
pub struct Gui {
    pub port: u16,
    pub token: String,
    /// The machine's name, for messages.
    pub name: String,
}

pub fn dir(config_dir: &Path) -> PathBuf {
    config_dir.join("guis")
}

/// What `setup` writes into `guis/<port>`.
pub fn entry_text(token: &str, name: &str) -> String {
    format!("{}\n{}\n", token.trim(), name.trim())
}

fn parse(port: u16, text: &str) -> Option<Gui> {
    let mut lines = text.lines().map(str::trim);
    let token = lines.next().filter(|t| !t.is_empty())?;
    Some(Gui {
        port,
        token: token.to_string(),
        name: lines.next().unwrap_or_default().to_string(),
    })
}

/// The registered machines, most recently set up first. Files that are not
/// `<port>` with a token inside are ignored.
pub fn list(dir: &Path) -> Vec<Gui> {
    let mut found: Vec<(std::time::SystemTime, Gui)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.filter_map(|e| e.ok()) {
            let Some(port) = entry
                .file_name()
                .to_str()
                .and_then(|n| n.parse::<u16>().ok())
            else {
                continue;
            };
            let Some(gui) = std::fs::read_to_string(entry.path())
                .ok()
                .and_then(|t| parse(port, &t))
            else {
                continue;
            };
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            found.push((modified, gui));
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.port.cmp(&b.1.port)));
    found.into_iter().map(|(_, g)| g).collect()
}

/// The loopback port a TCP candidate names, if it is one.
fn loopback_port(cand: &Candidate) -> Option<u16> {
    let Candidate::Tcp(addr) = cand else {
        return None;
    };
    let (host, port) = addr.rsplit_once(':')?;
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
        .then(|| port.parse().ok())
        .flatten()
}

/// The machine a candidate leads to, when it is a registered one.
pub fn gui_for<'a>(guis: &'a [Gui], cand: &Candidate) -> Option<&'a Gui> {
    let port = loopback_port(cand)?;
    guis.iter().find(|g| g.port == port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn a_machine_keeps_its_port_and_stays_clear_of_the_old_one() {
        let a = port_for("e0d5910bc42aa719");
        assert_eq!(a, port_for("e0d5910bc42aa719\n"));
        assert_ne!(a, port_for("a52482a3ea21c843"));
        // Pinned: a changed hash would silently move every user's forward.
        assert_eq!(port_for("token"), 48600);
        for t in ["", "a", "b", "0123456789abcdef", "zzzz"] {
            let p = port_for(t);
            assert!((FIRST_PORT..FIRST_PORT + PORTS).contains(&p), "{t}: {p}");
        }
    }

    #[test]
    fn entries_list_newest_first_and_skip_what_is_not_one() {
        let tmp = TempDir::new().unwrap();
        let d = dir(tmp.path());
        assert_eq!(list(&d), Vec::new());
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("47900"), entry_text("tok-a", "home")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(d.join("48000"), entry_text(" tok-b ", " gpdmd ")).unwrap();
        std::fs::write(d.join("48001"), "\n").unwrap(); // no token
        std::fs::write(d.join("notes.txt"), "tok").unwrap(); // not a port
        std::fs::write(d.join("99999"), "tok").unwrap(); // not a port either
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(d.join("48002"), "bare-token").unwrap(); // no name: fine
        let got = list(&d);
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].port, 48002);
        assert_eq!(got[0].name, "");
        assert_eq!(
            got[1],
            Gui {
                port: 48000,
                token: "tok-b".into(),
                name: "gpdmd".into()
            }
        );
        assert_eq!(got[2].port, 47900);
    }

    #[test]
    fn a_candidate_finds_its_machine_only_on_loopback() {
        let guis = [Gui {
            port: 47900,
            token: "t".into(),
            name: "home".into(),
        }];
        let tcp = |a: &str| Candidate::Tcp(a.to_string());
        assert_eq!(gui_for(&guis, &tcp("127.0.0.1:47900")), Some(&guis[0]));
        assert_eq!(gui_for(&guis, &tcp("localhost:47900")), Some(&guis[0]));
        assert_eq!(gui_for(&guis, &tcp("127.0.0.1:47821")), None);
        // Never hand a machine's token to some other address.
        assert_eq!(gui_for(&guis, &tcp("10.0.0.5:47900")), None);
        assert_eq!(gui_for(&guis, &tcp("47900")), None);
        assert_eq!(gui_for(&guis, &Candidate::Socket("/x/47900".into())), None);
    }
}
