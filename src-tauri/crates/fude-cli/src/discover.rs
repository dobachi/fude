//! Finding a GUI to talk to.
//!
//! Order: `$FUDE_GUI_SOCK` / `$FUDE_GUI_ADDR` when set; the Unix sockets an
//! ssh `RemoteForward` created under `~/.cache/fude/gui/` (newest first — a
//! stale one from a dead connection is unlinked when it refuses); the TCP
//! port an ssh `RemoteForward 47821 …` listens on (sshd creates Unix
//! sockets as root on some systems, which makes TCP the portable choice);
//! finally the local GUI's own socket.

use fude_core::ipc::{self, socket_name, Message, SOCKET_ENV};
use interprocess::local_socket::{prelude::*, Stream};
use std::io::{self, BufRead, BufReader, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long to wait for the GUI's `welcome` before giving up on a socket.
/// ssh accepts a forwarded connection even when nothing listens on the far
/// end and only then closes it, so "connected" alone proves nothing.
pub const WELCOME_TIMEOUT: Duration = Duration::from_secs(5);

/// Environment variable naming a TCP `host:port` to try first.
pub const ADDR_ENV: &str = "FUDE_GUI_ADDR";

/// The loopback port an ssh `RemoteForward` is expected to use.
pub const DEFAULT_TCP_ADDR: &str = "127.0.0.1:47821";

/// One place a GUI might be listening.
#[derive(Debug, Clone, PartialEq)]
pub enum Candidate {
    Socket(PathBuf),
    Tcp(String),
}

impl std::fmt::Display for Candidate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Candidate::Socket(p) => write!(f, "{}", p.display()),
            Candidate::Tcp(a) => write!(f, "tcp://{}", a),
        }
    }
}

/// The directory ssh forwards land in (`~/.cache/fude/gui`).
pub fn forward_dir(cache_dir: &Path) -> PathBuf {
    cache_dir.join("fude").join("gui")
}

/// Candidates in the order to try them.
pub fn candidates(forward_dir: &Path, local_socket: &Path) -> Vec<Candidate> {
    if let Some(p) = std::env::var_os(SOCKET_ENV).filter(|p| !p.is_empty()) {
        return vec![Candidate::Socket(PathBuf::from(p))];
    }
    if let Some(a) = std::env::var(ADDR_ENV)
        .ok()
        .filter(|a| !a.trim().is_empty())
    {
        return vec![Candidate::Tcp(a.trim().to_string())];
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
    let mut out: Vec<Candidate> = found
        .into_iter()
        .map(|(_, p)| Candidate::Socket(p))
        .collect();
    out.push(Candidate::Tcp(DEFAULT_TCP_ADDR.to_string()));
    out.push(Candidate::Socket(local_socket.to_path_buf()));
    out
}

/// A live connection that has completed the `hello` / `welcome` handshake.
pub struct Connected {
    pub reader: Box<dyn BufRead + Send>,
    pub writer: Box<dyn Write + Send>,
    pub via: Candidate,
    pub gui_version: Option<String>,
}

impl std::fmt::Debug for Connected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Connected({})", self.via)
    }
}

/// Connect to the first candidate that answers `hello` with `welcome`.
/// Returns the reasons each candidate was rejected on failure.
pub fn connect_any(cands: &[Candidate], hello: &Message) -> Result<Connected, Vec<String>> {
    let mut reasons = Vec::new();
    for cand in cands {
        match try_one(cand, hello) {
            Ok(c) => return Ok(c),
            Err(e) => {
                let refused = e.kind() == io::ErrorKind::ConnectionRefused;
                reasons.push(format!("{}: {}", cand, e));
                #[cfg(unix)]
                {
                    // A refusing socket file is a corpse (its ssh session or
                    // GUI is gone); nobody rebinds it, so stop retrying it.
                    if let Candidate::Socket(sock) = cand {
                        if refused && sock.exists() {
                            let _ = std::fs::remove_file(sock);
                        }
                    }
                }
                #[cfg(not(unix))]
                let _ = refused;
            }
        }
    }
    Err(reasons)
}

type Halves = (Box<dyn BufRead + Send>, Box<dyn Write + Send>);

/// Connect to the first candidate that accepts, without any handshake (for
/// `fude-cli pipe`, which relays somebody else's conversation).
pub fn connect_raw(cands: &[Candidate]) -> Result<Halves, Vec<String>> {
    let mut reasons = Vec::new();
    for cand in cands {
        match open(cand) {
            Ok(rw) => return Ok(rw),
            Err(e) => reasons.push(format!("{}: {}", cand, e)),
        }
    }
    Err(reasons)
}

fn try_one(cand: &Candidate, hello: &Message) -> io::Result<Connected> {
    let (reader, writer) = open(cand)?;
    handshake(reader, writer, cand.clone(), hello)
}

fn open(cand: &Candidate) -> io::Result<Halves> {
    let halves: Halves = match cand {
        Candidate::Socket(sock) => {
            let name = socket_name(sock)?;
            let (recv, send) = Stream::connect(name)?.split();
            (Box::new(BufReader::new(recv)), Box::new(send))
        }
        Candidate::Tcp(addr) => {
            let sa = addr
                .to_socket_addrs()?
                .next()
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "bad address"))?;
            let stream = TcpStream::connect_timeout(&sa, Duration::from_secs(2))?;
            let _ = stream.set_nodelay(true);
            let w = stream.try_clone()?;
            (Box::new(BufReader::new(stream)), Box::new(w))
        }
    };
    Ok(halves)
}

/// Send `hello` and wait for `welcome`. The handshake read blocks, and a
/// peer that accepts but never answers (a hung GUI, a forward to the wrong
/// thing) must not hang us with it: read on a helper thread and give up
/// after WELCOME_TIMEOUT. On timeout the helper is abandoned with the
/// stream; it ends with the process.
fn handshake(
    mut reader: Box<dyn BufRead + Send>,
    mut writer: Box<dyn Write + Send>,
    via: Candidate,
    hello: &Message,
) -> io::Result<Connected> {
    writer.write_all(ipc::encode(hello).as_bytes())?;
    writer.flush()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let r = await_welcome(&mut *reader);
        let _ = tx.send((r, reader));
    });
    match rx.recv_timeout(WELCOME_TIMEOUT) {
        Ok((Ok(gui_version), reader)) => Ok(Connected {
            reader,
            writer,
            via,
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
fn await_welcome(reader: &mut dyn BufRead) -> io::Result<Option<String>> {
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

    fn hello() -> Message {
        Message::Hello {
            protocol: ipc::PROTOCOL_VERSION,
            cwd: None,
            cli_version: None,
            host: None,
            token: None,
        }
    }

    #[test]
    fn candidates_prefer_newest_forward_then_tcp_then_local() {
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
        std::env::remove_var(ADDR_ENV);
        let c = candidates(&fwd, &local);
        assert_eq!(
            c,
            vec![
                Candidate::Socket(fwd.join("new.sock")),
                Candidate::Socket(old),
                Candidate::Tcp(DEFAULT_TCP_ADDR.into()),
                Candidate::Socket(local.clone()),
            ]
        );

        std::env::set_var(ADDR_ENV, "10.0.0.1:1234");
        assert_eq!(
            candidates(&fwd, &local),
            vec![Candidate::Tcp("10.0.0.1:1234".into())]
        );
        std::env::set_var(SOCKET_ENV, "/x/override.sock");
        assert_eq!(
            candidates(&fwd, &local),
            vec![Candidate::Socket(PathBuf::from("/x/override.sock"))]
        );
        std::env::remove_var(SOCKET_ENV);
        std::env::remove_var(ADDR_ENV);
    }

    #[test]
    fn missing_forward_dir_still_yields_tcp_and_the_local_socket() {
        std::env::remove_var(SOCKET_ENV);
        std::env::remove_var(ADDR_ENV);
        let c = candidates(Path::new("/nonexistent/dir"), Path::new("/l.sock"));
        assert_eq!(
            c,
            vec![
                Candidate::Tcp(DEFAULT_TCP_ADDR.into()),
                Candidate::Socket(PathBuf::from("/l.sock"))
            ]
        );
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

        let refused = ipc::encode(&Message::Error {
            path: None,
            message: "bad token".into(),
        });
        let e = await_welcome(&mut refused.as_bytes()).unwrap_err();
        assert_eq!(e.to_string(), "bad token");
    }

    // Uses a filesystem socket path, which Windows named pipes cannot be.
    #[cfg(unix)]
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
        let start = std::time::Instant::now();
        let e = try_one(&Candidate::Socket(sock), &hello()).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::TimedOut);
        assert!(start.elapsed() < WELCOME_TIMEOUT + Duration::from_secs(2));
        drop(keep); // the helper threads end with the test process
    }

    #[test]
    fn tcp_candidates_complete_the_same_handshake() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut r = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            r.read_line(&mut line).unwrap();
            assert!(line.contains("\"hello\""));
            let mut w = stream;
            w.write_all(
                ipc::encode(&Message::Welcome {
                    protocol: ipc::PROTOCOL_VERSION,
                    gui_version: Some("t".into()),
                })
                .as_bytes(),
            )
            .unwrap();
        });
        let c = try_one(&Candidate::Tcp(addr.to_string()), &hello()).unwrap();
        assert_eq!(c.gui_version.as_deref(), Some("t"));
        assert_eq!(c.via, Candidate::Tcp(addr.to_string()));
        server.join().unwrap();
    }

    #[test]
    fn connecting_to_nothing_reports_every_candidate() {
        let tmp = TempDir::new().unwrap();
        let dead = tmp.path().join("dead.sock");
        let cands = vec![
            Candidate::Socket(dead.clone()),
            Candidate::Tcp("127.0.0.1:1".into()),
        ];
        let reasons = connect_any(&cands, &hello()).unwrap_err();
        assert_eq!(reasons.len(), 2);
        assert!(reasons[0].starts_with(&dead.to_string_lossy().to_string()));
        assert!(reasons[1].starts_with("tcp://127.0.0.1:1"));
    }
}
