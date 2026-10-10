//! WSL → Windows: make the Fude running on Windows "the" GUI for everything
//! that happens in WSL.
//!
//! `fude-cli bridge` (in WSL) listens where a WSL Fude would
//! (`~/.config/fude/gui.sock`) and hands every connection to
//! `fude-cli.exe pipe`, a Windows process WSL interop lets us talk to over
//! stdin/stdout, which connects to the Windows Fude's named pipe. Nothing
//! crosses the WSL network boundary, so there is no firewall prompt, no
//! host IP to track and no ssh from PowerShell: `fude-cli notes.md` in WSL
//! and in any `ssh` session started from WSL (whose RemoteForward targets
//! that same socket) both end up in the Windows window.

use fude_core::ipc::{self, Message};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// Copy `from` to `to` until either ends, flushing each chunk: the protocol
/// is conversational, so nothing may sit in a buffer.
pub fn pump(mut from: impl Read, mut to: impl Write) {
    let mut buf = [0u8; 8192];
    loop {
        match from.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                if to.write_all(&buf[..n]).is_err() || to.flush().is_err() {
                    return;
                }
            }
        }
    }
}

/// Decide whether a client's first line may cross the bridge.
///
/// The Windows GUI cannot read WSL paths itself, so only agents (a `hello`
/// that names its host and will serve the files) are let through. A local
/// `fude --wait` sends no host and would leave the GUI asking for files
/// nobody answers; it is told what to use instead.
pub fn admit(first_line: &str) -> Result<(), Message> {
    match ipc::decode(first_line) {
        Ok(Some(Message::Hello { host: Some(h), .. })) if !h.is_empty() => Ok(()),
        Ok(Some(Message::Hello { .. })) => Err(Message::Error {
            path: None,
            message: "this socket is bridged to the Fude on Windows, which cannot read WSL \
                      paths directly: use `fude-cli --wait FILE` instead of `fude --wait`"
                .into(),
        }),
        _ => Err(Message::Error {
            path: None,
            message: "expected hello".into(),
        }),
    }
}

/// `fude-cli pipe` (the Windows half): connect to the local GUI and relay
/// stdin/stdout. Tries the GUI's own socket / named pipe first, then its
/// loopback TCP port.
pub fn run_pipe(candidates: &[crate::discover::Candidate]) -> i32 {
    let (reader, writer) = match crate::discover::connect_raw(candidates) {
        Ok(rw) => rw,
        Err(reasons) => {
            // The peer is a program; answer in protocol so the client can
            // show why, then leave.
            let msg = Message::Error {
                path: None,
                message: format!("no Fude GUI on Windows answers ({})", reasons.join("; ")),
            };
            let mut out = io::stdout();
            let _ = out.write_all(ipc::encode(&msg).as_bytes());
            let _ = out.write_all(ipc::encode(&Message::Bye).as_bytes());
            let _ = out.flush();
            return 2;
        }
    };
    let up = std::thread::spawn(move || pump(io::stdin(), writer));
    pump(reader, io::stdout());
    drop(up); // stdin may never end; the process exits with the GUI's side
    0
}

#[cfg(unix)]
pub use unix::run_bridge;

#[cfg(not(unix))]
pub fn run_bridge(_exe: Option<&str>) -> i32 {
    eprintln!("fude-cli bridge runs inside WSL");
    2
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::os::unix::net::{UnixListener, UnixStream};

    /// Where the Windows `fude-cli.exe` may be, in the order tried:
    /// `$FUDE_CLI_EXE`, a cached download, then next to an installed Fude.
    pub fn exe_candidates(cache_dir: &Path, win_users: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        if let Some(p) = std::env::var_os("FUDE_CLI_EXE").filter(|p| !p.is_empty()) {
            out.push(PathBuf::from(p));
        }
        out.push(cache_dir.join("fude").join("fude-cli.exe"));
        if let Ok(rd) = std::fs::read_dir(win_users) {
            for user in rd.filter_map(|e| e.ok()) {
                let base = user.path().join("AppData/Local");
                out.push(base.join("Fude/fude-cli.exe"));
                out.push(base.join("Programs/Fude/fude-cli.exe"));
            }
        }
        out.push(PathBuf::from("/mnt/c/Program Files/Fude/fude-cli.exe"));
        out
    }

    const RELEASE_EXE: &str =
        "https://github.com/dobachi/fude/releases/latest/download/fude-cli-windows-x86_64.exe";

    /// WSL runs a Windows exe only if the file is executable; a download
    /// (curl, a browser, an unpacked artifact) lands without that bit.
    pub fn ensure_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let mode = meta.permissions().mode();
            if mode & 0o111 == 0 {
                let _ =
                    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode | 0o755));
            }
        }
    }

    fn find_or_fetch_exe(explicit: Option<&str>) -> Result<PathBuf, String> {
        let exe = locate_exe(explicit)?;
        ensure_executable(&exe);
        Ok(exe)
    }

    fn locate_exe(explicit: Option<&str>) -> Result<PathBuf, String> {
        if let Some(p) = explicit {
            let p = PathBuf::from(p);
            return if p.is_file() {
                Ok(p)
            } else {
                Err(format!("{} not found", p.display()))
            };
        }
        let cache = dirs::cache_dir().unwrap_or_else(std::env::temp_dir);
        let cands = exe_candidates(&cache, Path::new("/mnt/c/Users"));
        if let Some(p) = cands.iter().find(|p| p.is_file()) {
            return Ok(p.clone());
        }
        let dest = cache.join("fude").join("fude-cli.exe");
        if let Some(dir) = dest.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        eprintln!("fude-cli bridge: downloading {}", RELEASE_EXE);
        let ok = Command::new("curl")
            .args(["-fsSL", "-o"])
            .arg(&dest)
            .arg(RELEASE_EXE)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok && dest.is_file() {
            Ok(dest)
        } else {
            let _ = std::fs::remove_file(&dest);
            Err("could not find or download fude-cli.exe (set FUDE_CLI_EXE)".into())
        }
    }

    /// `%APPDATA%\fude` as a WSL path, asked of Windows itself.
    fn windows_config_dir() -> Option<PathBuf> {
        let out = Command::new("cmd.exe")
            .args(["/C", "echo %APPDATA%"])
            .current_dir("/mnt/c")
            .stderr(Stdio::null())
            .output()
            .ok()?;
        let win = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if win.is_empty() || win.contains('%') {
            return None;
        }
        let out = Command::new("wslpath").args(["-u", &win]).output().ok()?;
        let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!p.is_empty()).then(|| PathBuf::from(p).join("fude"))
    }

    /// Give the Windows GUI the token WSL-side agents present (remote hosts
    /// were set up with the WSL one). Returns true when the file changed,
    /// i.e. a running Windows Fude must be restarted to pick it up.
    pub fn sync_token(wsl_token: &Path, win_dir: &Path) -> Result<bool, String> {
        let token = fude_core::token::load_or_create(wsl_token)?;
        let dest = win_dir.join(fude_core::token::TOKEN_FILE);
        if fude_core::token::read(&dest).ok().flatten().as_deref() == Some(token.as_str()) {
            return Ok(false);
        }
        std::fs::create_dir_all(win_dir).map_err(|e| e.to_string())?;
        std::fs::write(&dest, format!("{}\n", token)).map_err(|e| e.to_string())?;
        Ok(true)
    }

    /// Serve one client: check its hello, then splice it to a fresh child.
    pub fn serve_conn(client: UnixStream, spawn: &dyn Fn() -> io::Result<Child>) {
        let Ok(mut client_w) = client.try_clone() else {
            return;
        };
        let mut reader = BufReader::new(client);
        let mut first = String::new();
        if reader.read_line(&mut first).unwrap_or(0) == 0 {
            return;
        }
        if let Err(msg) = admit(&first) {
            let _ = client_w.write_all(ipc::encode(&msg).as_bytes());
            let _ = client_w.write_all(ipc::encode(&Message::Bye).as_bytes());
            return;
        }
        let mut child = match spawn() {
            Ok(c) => c,
            Err(e) => {
                let msg = Message::Error {
                    path: None,
                    message: format!("cannot start fude-cli.exe: {}", e),
                };
                let _ = client_w.write_all(ipc::encode(&msg).as_bytes());
                return;
            }
        };
        let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            return;
        };
        if stdin.write_all(first.as_bytes()).is_err() {
            let _ = child.kill();
            return;
        }
        let _ = stdin.flush();
        // client → child on a helper thread; child → client here. When the
        // GUI side ends, shut the client down so the helper's read returns.
        let up = std::thread::spawn(move || pump(reader, stdin));
        pump(stdout, &client_w);
        let _ = client_w.shutdown(std::net::Shutdown::Both);
        let _ = child.kill();
        let _ = child.wait();
        let _ = up.join();
    }

    /// Bind `socket`, replacing a dead one but never a live one.
    pub fn bind(socket: &Path) -> Result<UnixListener, String> {
        if socket.exists() {
            if UnixStream::connect(socket).is_ok() {
                return Err(format!(
                    "{} is in use: close the Fude (or bridge) running in WSL first",
                    socket.display()
                ));
            }
            let _ = std::fs::remove_file(socket);
        }
        if let Some(dir) = socket.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let l = UnixListener::bind(socket)
            .map_err(|e| format!("cannot listen on {}: {}", socket.display(), e))?;
        let _ = fude_core::paths::set_file_permissions(socket);
        Ok(l)
    }

    pub fn run_bridge(exe: Option<&str>) -> i32 {
        match run_inner(exe) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("fude-cli bridge: {}", e);
                2
            }
        }
    }

    fn run_inner(exe: Option<&str>) -> Result<(), String> {
        let exe = find_or_fetch_exe(exe)?;
        let config_dir = fude_core::config_dir()?;
        let socket = ipc::socket_path(&config_dir);
        let listener = bind(&socket)?;

        match windows_config_dir() {
            Some(win) => match sync_token(&config_dir.join(fude_core::token::TOKEN_FILE), &win) {
                Ok(true) => eprintln!(
                    "fude-cli bridge: wrote the GUI token to {} — restart Fude on Windows once",
                    win.display()
                ),
                Ok(false) => {}
                Err(e) => eprintln!("fude-cli bridge: could not sync the token: {}", e),
            },
            None => eprintln!("fude-cli bridge: could not locate %APPDATA% (token not synced)"),
        }

        eprintln!(
            "fude-cli bridge: {} → {} pipe → Fude on Windows (Ctrl+C stops)",
            socket.display(),
            exe.display()
        );
        let cleanup = socket.clone();
        for conn in listener.incoming() {
            let Ok(stream) = conn else { continue };
            let exe = exe.clone();
            std::thread::spawn(move || {
                serve_conn(stream, &|| {
                    Command::new(&exe)
                        .arg("pipe")
                        // A Windows process cannot start in a WSL directory.
                        .current_dir("/mnt/c")
                        .stdin(Stdio::piped())
                        .stdout(Stdio::piped())
                        .stderr(Stdio::null())
                        .spawn()
                });
            });
        }
        let _ = std::fs::remove_file(cleanup);
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use tempfile::TempDir;

        fn hello(host: Option<&str>) -> String {
            ipc::encode(&Message::Hello {
                protocol: ipc::PROTOCOL_VERSION,
                cwd: None,
                cli_version: None,
                host: host.map(str::to_string),
                token: None,
            })
        }

        #[test]
        fn only_agents_are_admitted() {
            assert!(admit(&hello(Some("box"))).is_ok());
            assert!(matches!(
                admit(&hello(None)),
                Err(Message::Error { message, .. }) if message.contains("fude-cli --wait")
            ));
            assert!(admit(&hello(Some(""))).is_err());
            assert!(admit("garbage\n").is_err());
            assert!(admit(&ipc::encode(&Message::Bye)).is_err());
        }

        #[test]
        fn a_connection_is_spliced_to_the_child_both_ways() {
            let tmp = TempDir::new().unwrap();
            let sock = tmp.path().join("gui.sock");
            let listener = bind(&sock).unwrap();
            // `cat` stands in for fude-cli.exe: it echoes what it is sent.
            let server = std::thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                serve_conn(stream, &|| {
                    Command::new("cat")
                        .stdin(Stdio::piped())
                        .stdout(Stdio::piped())
                        .spawn()
                });
            });
            let mut c = UnixStream::connect(&sock).unwrap();
            let h = hello(Some("box"));
            c.write_all(h.as_bytes()).unwrap();
            c.write_all(b"second line\n").unwrap();
            let mut r = BufReader::new(c.try_clone().unwrap());
            let mut line = String::new();
            r.read_line(&mut line).unwrap();
            assert_eq!(line, h);
            line.clear();
            r.read_line(&mut line).unwrap();
            assert_eq!(line, "second line\n");
            c.shutdown(std::net::Shutdown::Both).unwrap();
            server.join().unwrap();
        }

        #[test]
        fn a_hello_without_host_is_refused_without_starting_a_child() {
            let tmp = TempDir::new().unwrap();
            let sock = tmp.path().join("gui.sock");
            let listener = bind(&sock).unwrap();
            let server = std::thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                serve_conn(stream, &|| panic!("must not spawn"));
            });
            let mut c = UnixStream::connect(&sock).unwrap();
            c.write_all(hello(None).as_bytes()).unwrap();
            let mut r = BufReader::new(c.try_clone().unwrap());
            let mut line = String::new();
            r.read_line(&mut line).unwrap();
            assert!(line.contains("\"error\""));
            line.clear();
            r.read_line(&mut line).unwrap();
            assert!(line.contains("\"bye\""));
            server.join().unwrap();
        }

        // The bridge only ever runs in WSL; macOS treats a closed listener's
        // socket file differently, which is of no interest here.
        #[cfg(target_os = "linux")]
        #[test]
        fn bind_replaces_a_dead_socket_and_refuses_a_live_one() {
            let tmp = TempDir::new().unwrap();
            let sock = tmp.path().join("gui.sock");
            drop(UnixListener::bind(&sock).unwrap()); // leaves the file behind
            assert!(sock.exists());
            let live = bind(&sock).unwrap();
            assert!(bind(&sock).unwrap_err().contains("in use"));
            drop(live);
        }

        #[test]
        fn the_token_is_copied_once_and_then_left_alone() {
            let tmp = TempDir::new().unwrap();
            let wsl = tmp.path().join("wsl/gui-token");
            let win = tmp.path().join("win/fude");
            assert!(sync_token(&wsl, &win).unwrap());
            let t = std::fs::read_to_string(&wsl).unwrap();
            assert_eq!(std::fs::read_to_string(win.join("gui-token")).unwrap(), t);
            assert!(!sync_token(&wsl, &win).unwrap());
            std::fs::write(win.join("gui-token"), "other\n").unwrap();
            assert!(sync_token(&wsl, &win).unwrap());
        }

        #[test]
        fn a_downloaded_exe_is_made_executable() {
            use std::os::unix::fs::PermissionsExt;
            let tmp = TempDir::new().unwrap();
            let exe = tmp.path().join("fude-cli.exe");
            std::fs::write(&exe, "MZ").unwrap();
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o644)).unwrap();
            ensure_executable(&exe);
            let mode = std::fs::metadata(&exe).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111);
            ensure_executable(&tmp.path().join("missing.exe")); // no panic
        }

        #[test]
        fn exe_candidates_cover_the_cache_and_windows_installs() {
            let tmp = TempDir::new().unwrap();
            let users = tmp.path().join("Users");
            std::fs::create_dir_all(users.join("me")).unwrap();
            std::env::remove_var("FUDE_CLI_EXE");
            let c = exe_candidates(&tmp.path().join("cache"), &users);
            assert_eq!(c[0], tmp.path().join("cache/fude/fude-cli.exe"));
            assert!(c.contains(&users.join("me/AppData/Local/Fude/fude-cli.exe")));
            std::env::set_var("FUDE_CLI_EXE", "/x/fude-cli.exe");
            let c = exe_candidates(&tmp.path().join("cache"), &users);
            assert_eq!(c[0], PathBuf::from("/x/fude-cli.exe"));
            std::env::remove_var("FUDE_CLI_EXE");
        }
    }
}
