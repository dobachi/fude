//! Finding a GUI to talk to.
//!
//! Order: `$FUDE_GUI_SOCK`; the sockets an ssh `RemoteForward` created under
//! `~/.cache/fude/gui/` (newest first — a stale one from a dead connection
//! is unlinked when it refuses); finally the local GUI's own socket.

use fude_core::ipc::{self, socket_name, Message, SOCKET_ENV};
use interprocess::local_socket::{prelude::*, Stream};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long to wait for the GUI's `welcome` before giving up on a socket.
/// ssh accepts a forwarded connection even when nothing listens on the far
/// end and only then closes it, so "connected" alone proves nothing.
pub const WELCOME_TIMEOUT: Duration = Duration::from_secs(5);

/// The directory ssh forwards land in (`~/.cache/fude/gui`).
pub fn forward_dir(cache_dir: &Path) -> PathBuf {
    cache_dir.join("fude").join("gui")
}

/// Candidate socket paths in the order to try them.
pub fn candidates(forward_dir: &Path, local_socket: &Path) -> Vec<PathBuf> {
    if let Some(p) = std::env::var_os(SOCKET_ENV).filter(|p| !p.is_empty()) {
        return vec![PathBuf::from(p)];
    }
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(forward_dir) {
        for entry in rd.filter_map(|e| e.ok()) {
            let p = entry.path();
            if p.extension().map(|e| e == "sock").unwrap_or(false) {
                let t = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::UNIX_EPOCH);
                found.push((t, p));
            }
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out: Vec<PathBuf> = found.into_iter().map(|(_, p)| p).collect();
    out.push(local_socket.to_path_buf());
    out
}

/// A live connection that has completed the `hello` / `welcome` handshake.
#[derive(Debug)]
pub struct Connected {
    pub reader: BufReader<interprocess::local_socket::RecvHalf>,
    pub writer: interprocess::local_socket::SendHalf,
    pub socket: PathBuf,
    pub gui_version: Option<String>,
}

/// Connect to the first candidate that answers `hello` with `welcome`.
/// Returns the reasons each candidate was rejected on failure.
pub fn connect_any(cands: &[PathBuf], hello: &Message) -> Result<Connected, Vec<String>> {
    let mut reasons = Vec::new();
    for sock in cands {
        match try_one(sock, hello) {
            Ok(c) => return Ok(c),
            Err(e) => {
                let refused = e.kind() == io::ErrorKind::ConnectionRefused;
                reasons.push(format!("{}: {}", sock.display(), e));
                #[cfg(unix)]
                {
                    // A refusing socket file is a corpse (its ssh session or
                    // GUI is gone); nobody rebinds it, so stop retrying it.
                    if refused && sock.exists() {
                        let _ = std::fs::remove_file(sock);
                    }
                }
                #[cfg(not(unix))]
                let _ = refused;
            }
        }
    }
    Err(reasons)
}

fn try_one(sock: &Path, hello: &Message) -> io::Result<Connected> {
    let name = socket_name(sock)?;
    let stream = Stream::connect(name)?;
    let (recv, mut send) = stream.split();
    send.write_all(ipc::encode(hello).as_bytes())?;
    send.flush()?;
    // The handshake read blocks, and a peer that accepts but never answers
    // (a hung GUI, a forward to the wrong thing) must not hang us with it:
    // read on a helper thread and give up after WELCOME_TIMEOUT. On timeout
    // the helper is abandoned with the stream; it ends with the process.
    let mut reader = BufReader::new(recv);
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let r = await_welcome(&mut reader);
        let _ = tx.send((r, reader));
    });
    match rx.recv_timeout(WELCOME_TIMEOUT) {
        Ok((Ok(gui_version), reader)) => Ok(Connected {
            reader,
            writer: send,
            socket: sock.to_path_buf(),
            gui_version,
        }),
        Ok((Err(e), _)) => Err(e),
        Err(_) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!("no welcome within {:?}", WELCOME_TIMEOUT),
        )),
    }
}

/// Read until `welcome` (or fail). A dead ssh forward closes the stream at
/// once (EOF); a peer that never answers is cut off by the caller's timeout.
fn await_welcome<R: BufRead>(reader: &mut R) -> io::Result<Option<String>> {
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "closed before welcome (no GUI behind this socket?)",
            ));
        }
        match ipc::decode(&line) {
            Ok(Some(Message::Welcome {
                protocol,
                gui_version,
            })) => {
                if protocol != ipc::PROTOCOL_VERSION {
                    return Err(io::Error::new(
                        io::ErrorKind::Unsupported,
                        format!("GUI speaks protocol {}", protocol),
                    ));
                }
                return Ok(gui_version);
            }
            Ok(Some(Message::Error { message, .. })) => {
                return Err(io::Error::other(message));
            }
            Ok(Some(Message::Bye)) => {
                return Err(io::Error::new(io::ErrorKind::ConnectionReset, "bye"));
            }
            Ok(_) => continue,
            Err(e) => return Err(io::Error::new(io::ErrorKind::InvalidData, e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn candidates_prefer_newest_forward_then_local() {
        let tmp = TempDir::new().unwrap();
        let fwd = forward_dir(tmp.path());
        fs::create_dir_all(&fwd).unwrap();
        fs::write(fwd.join("old.sock"), "").unwrap();
        fs::write(fwd.join("ignored.txt"), "").unwrap();
        let old = fwd.join("old.sock");
        let t = std::time::SystemTime::now() - Duration::from_secs(60);
        let f = fs::File::options().write(true).open(&old).unwrap();
        f.set_modified(t).unwrap();
        fs::write(fwd.join("new.sock"), "").unwrap();
        let local = tmp.path().join("gui.sock");

        std::env::remove_var(SOCKET_ENV);
        let c = candidates(&fwd, &local);
        assert_eq!(c, vec![fwd.join("new.sock"), old, local.clone()]);

        std::env::set_var(SOCKET_ENV, "/x/override.sock");
        assert_eq!(
            candidates(&fwd, &local),
            vec![PathBuf::from("/x/override.sock")]
        );
        std::env::remove_var(SOCKET_ENV);
    }

    #[test]
    fn missing_forward_dir_still_yields_the_local_socket() {
        std::env::remove_var(SOCKET_ENV);
        let c = candidates(Path::new("/nonexistent/dir"), Path::new("/l.sock"));
        assert_eq!(c, vec![PathBuf::from("/l.sock")]);
    }

    #[test]
    fn welcome_handshake_accepts_only_a_matching_welcome() {
        let ok = format!(
            "{}{}",
            ipc::encode(&Message::Opened { path: "x".into() }),
            ipc::encode(&Message::Welcome {
                protocol: ipc::PROTOCOL_VERSION,
                gui_version: Some("1".into())
            })
        );
        assert_eq!(
            await_welcome(&mut ok.as_bytes()).unwrap(),
            Some("1".to_string())
        );

        let eof = "";
        let e = await_welcome(&mut eof.as_bytes()).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::ConnectionReset);

        let wrong = ipc::encode(&Message::Welcome {
            protocol: 99,
            gui_version: None,
        });
        let e = await_welcome(&mut wrong.as_bytes()).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::Unsupported);
    }

    #[test]
    fn a_silent_peer_is_given_up_on_after_the_timeout() {
        use interprocess::local_socket::{GenericFilePath, ListenerOptions};
        let tmp = TempDir::new().unwrap();
        let sock = tmp.path().join("silent.sock");
        let name = sock.clone().to_fs_name::<GenericFilePath>().unwrap();
        // Accepts and then says nothing.
        let listener = ListenerOptions::new().name(name).create_sync().unwrap();
        let keep = std::thread::spawn(move || {
            let conn = listener.incoming().next();
            std::thread::sleep(Duration::from_secs(10));
            drop(conn);
        });
        let hello = Message::Hello {
            protocol: ipc::PROTOCOL_VERSION,
            cwd: None,
            cli_version: None,
            host: None,
        };
        let start = std::time::Instant::now();
        let e = try_one(&sock, &hello).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::TimedOut);
        assert!(start.elapsed() < WELCOME_TIMEOUT + Duration::from_secs(2));
        drop(keep); // the helper threads end with the test process
    }

    #[test]
    fn connecting_to_nothing_reports_every_candidate() {
        let tmp = TempDir::new().unwrap();
        let dead = tmp.path().join("dead.sock");
        let hello = Message::Hello {
            protocol: ipc::PROTOCOL_VERSION,
            cwd: None,
            cli_version: None,
            host: None,
        };
        let reasons = connect_any(std::slice::from_ref(&dead), &hello).unwrap_err();
        assert_eq!(reasons.len(), 1);
        assert!(reasons[0].starts_with(&dead.to_string_lossy().to_string()));
    }
}
