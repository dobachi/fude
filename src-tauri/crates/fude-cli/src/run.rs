//! The agent's main loop: connect to a GUI, ask it to open our paths, serve
//! its file requests and report changes until every tab is closed.

use crate::agent::{Agent, Side};
use crate::args::Args;
use crate::discover::{self, Candidate, Connected};
use crate::watch::Watcher;
use fude_core::ipc::{self, Message, PROTOCOL_VERSION};
use fude_core::wait::{exit_code, WaitState};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;

/// The name this machine is announced under: `$FUDE_HOST`, else the hostname.
pub fn host_name() -> String {
    if let Ok(h) = std::env::var("FUDE_HOST") {
        if !h.trim().is_empty() {
            return h.trim().to_string();
        }
    }
    if let Ok(h) = std::env::var("HOSTNAME") {
        if !h.trim().is_empty() {
            return h.trim().to_string();
        }
    }
    if let Ok(h) = std::fs::read_to_string("/etc/hostname") {
        if !h.trim().is_empty() {
            return h.trim().to_string();
        }
    }
    "remote".to_string()
}

/// Where a detached agent's output goes.
pub fn log_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join("fude").join("agent.log")
}

enum Event {
    Line(String),
    Eof,
    Changed(PathBuf),
}

/// Resolve the operands against the working directory.
pub fn absolute_paths(paths: &[String]) -> Vec<String> {
    let cwd = std::env::current_dir().ok();
    paths
        .iter()
        .map(|p| fude_core::resolve_cli_path(p, cwd.clone()))
        .collect()
}

/// The token to present to `cand`: `$FUDE_GUI_TOKEN` when set, else the
/// token of the machine the candidate leads to, else the host's one
/// `gui-token` (setups made before machines had their own).
pub fn token_for(
    cand: &Candidate,
    guis: &[crate::guis::Gui],
    env: Option<String>,
    shared: Option<String>,
) -> Option<String> {
    env.filter(|t| !t.trim().is_empty())
        .map(|t| t.trim().to_string())
        .or_else(|| crate::guis::gui_for(guis, cand).map(|g| g.token.clone()))
        .or(shared)
}

/// `path` as `fude-cli here` reads it: `~` is the home directory, and so is
/// the place relative paths start from — its callers have no shell to
/// expand the one nor a working directory that means anything for the other.
pub fn home_path(home: &Path, path: &str) -> PathBuf {
    let p = path.trim();
    match p {
        "" | "~" => home.to_path_buf(),
        _ => match p.strip_prefix("~/") {
            Some(rest) => home.join(rest),
            None => home.join(p), // an absolute `p` replaces `home`
        },
    }
}

/// Environment variable naming the machine whose Fude to use (`--to`).
pub const TO_ENV: &str = "FUDE_TO";

/// A Fude that answered, and what to call it.
#[derive(Debug)]
pub struct Reached {
    pub conn: Connected,
    /// The machine's name when it is a registered one.
    pub name: Option<String>,
}

impl Reached {
    /// "Fude 0.8.9 on gpdmd" / "Fude 0.8.9 via tcp://127.0.0.1:47821".
    pub fn describe(&self) -> String {
        let version = self.conn.gui_version.as_deref().unwrap_or("?");
        match &self.name {
            Some(name) => format!("Fude {} on {}", version, name),
            None => format!("Fude {} via {}", version, self.conn.via),
        }
    }
}

/// What a registered machine is called: its name, or its port without one.
fn gui_label(gui: &crate::guis::Gui) -> String {
    if gui.name.is_empty() {
        format!("port {}", gui.port)
    } else {
        gui.name.clone()
    }
}

/// The registered machine `to` names: by name (ignoring case) or by port.
pub fn pick_named<'a>(
    guis: &'a [crate::guis::Gui],
    to: &str,
) -> Result<&'a crate::guis::Gui, String> {
    let want = to.trim();
    guis.iter()
        .find(|g| g.name.eq_ignore_ascii_case(want) || g.port.to_string() == want)
        .ok_or_else(|| {
            if guis.is_empty() {
                format!(
                    "no machine is set up to receive files from this host, so '{}' \
                     means nothing here (run `fude setup` for this host on that machine)",
                    want
                )
            } else {
                format!(
                    "no machine named '{}' is set up for this host (known: {})",
                    want,
                    guis.iter().map(gui_label).collect::<Vec<_>>().join(", ")
                )
            }
        })
}

/// The answer to "which one?": a number from 1 to `count`; an empty line
/// takes the first. Anything else is asked again.
pub fn parse_choice(input: &str, count: usize) -> Option<usize> {
    let t = input.trim();
    if t.is_empty() {
        return (count > 0).then_some(0);
    }
    t.parse::<usize>()
        .ok()
        .filter(|n| (1..=count).contains(n))
        .map(|n| n - 1)
}

/// Every Fude that may take the files, or why none does.
///
/// With `to`, only that machine is asked. Otherwise the candidates are
/// walked in order; the registered machines form one group in which every
/// one that answers is returned, because nothing on this host says which
/// of them the user is sitting at — a Tailscale SSH session carries no
/// trace of where it came from.
pub fn reachable(
    candidates: &[Candidate],
    guis: &[crate::guis::Gui],
    to: Option<&str>,
    hello_for: impl Fn(&Candidate) -> Message,
) -> Result<Vec<Reached>, String> {
    let failed = |reasons: Vec<String>| {
        let mut msg = String::from("no Fude GUI reachable:");
        for r in reasons {
            msg.push_str("\n  ");
            msg.push_str(&r);
        }
        msg
    };
    let named = |conn: Connected| Reached {
        name: crate::guis::gui_for(guis, &conn.via).map(gui_label),
        conn,
    };
    if let Some(to) = to.map(str::trim).filter(|t| !t.is_empty()) {
        let gui = pick_named(guis, to)?;
        let cand = Candidate::Tcp(format!("127.0.0.1:{}", gui.port));
        return discover::connect_with(&[cand], &hello_for)
            .map(|c| vec![named(c)])
            .map_err(failed);
    }
    let mut reasons = Vec::new();
    let mut answered = Vec::new();
    let mut asked_group = false;
    for cand in candidates {
        let registered = crate::guis::gui_for(guis, cand).is_some();
        if !registered && asked_group && !answered.is_empty() {
            break;
        }
        asked_group |= registered;
        match discover::connect_with(std::slice::from_ref(cand), &hello_for) {
            Ok(c) if registered => answered.push(named(c)),
            Ok(c) => return Ok(vec![named(c)]),
            Err(mut r) => reasons.append(&mut r),
        }
    }
    if answered.is_empty() {
        Err(failed(reasons))
    } else {
        Ok(answered)
    }
}

/// Settle on one of several Fudes. With a terminal the user is asked;
/// without one (an editor command in a script) the first is taken, and
/// said so.
fn choose(mut reached: Vec<Reached>) -> Result<Reached, String> {
    use std::io::IsTerminal;
    if reached.len() <= 1 {
        return reached.pop().ok_or_else(|| "no Fude GUI reachable".into());
    }
    let names: Vec<String> = reached
        .iter()
        .map(|r| r.name.clone().unwrap_or_else(|| r.conn.via.to_string()))
        .collect();
    let hint = format!("--to NAME or {}=NAME", TO_ENV);
    if !(std::io::stdin().is_terminal() && std::io::stderr().is_terminal()) {
        eprintln!(
            "fude-cli: Fude answers on {} machines ({}); using {} (choose with {})",
            names.len(),
            names.join(", "),
            names[0],
            hint
        );
        return Ok(reached.swap_remove(0));
    }
    eprintln!("fude-cli: Fude answers on {} machines:", names.len());
    for (n, name) in names.iter().enumerate() {
        eprintln!("  {}) {}", n + 1, name);
    }
    for _ in 0..3 {
        eprint!(
            "Open on which? [1-{}, Enter = 1] (skip this with {}): ",
            names.len(),
            hint
        );
        let mut line = String::new();
        match std::io::stdin().read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if let Some(n) = parse_choice(&line, names.len()) {
            return Ok(reached.swap_remove(n));
        }
    }
    Err("no machine chosen".into())
}

fn hello_maker() -> (Vec<crate::guis::Gui>, impl Fn(&Candidate) -> Message) {
    let config_dir = fude_core::config_dir().ok();
    let guis = config_dir
        .as_deref()
        .map(|d| crate::guis::list(&crate::guis::dir(d)))
        .unwrap_or_default();
    let shared = config_dir
        .as_deref()
        .and_then(|d| fude_core::token::read(&d.join(fude_core::token::TOKEN_FILE)).ok())
        .flatten();
    let env = std::env::var(fude_core::token::TOKEN_ENV).ok();
    let cwd = std::env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().to_string());
    let host = host_name();
    let for_hello = guis.clone();
    let hello_for = move |cand: &Candidate| Message::Hello {
        protocol: PROTOCOL_VERSION,
        cwd: cwd.clone(),
        cli_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        host: Some(host.clone()),
        token: token_for(cand, &for_hello, env.clone(), shared.clone()),
    };
    (guis, hello_for)
}

/// Greet the GUI that started this process, over stdin/stdout.
pub fn connect_stdio() -> Result<Connected, String> {
    let (_, hello_for) = hello_maker();
    let mut hello = hello_for(&Candidate::Stdio);
    // The pipe is the proof of who is asking; no secret travels on it.
    if let Message::Hello { token, .. } = &mut hello {
        *token = None;
    }
    discover::over_stdio(&hello).map_err(|e| format!("the GUI did not answer on stdio: {}", e))
}

/// The bytes a string of hex digits stands for, as text. Paths the GUI
/// sends travel this way: through ssh, a remote shell and (on Windows)
/// wsl.exe, where quoting rules differ and hex needs none.
pub fn unhex(hex: &str) -> Result<String, String> {
    let h = hex.trim();
    if !h.len().is_multiple_of(2) || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("not a hex string".into());
    }
    let bytes: Vec<u8> = (0..h.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap_or(0))
        .collect();
    String::from_utf8(bytes).map_err(|_| "not UTF-8".to_string())
}

/// How many completions are offered at most.
pub const COMPLETIONS_MAX: usize = 200;

/// What `partial` could be completed to, read like `here` reads paths:
/// the entries of its directory part whose names start with the rest,
/// directories with a trailing `/`. The directory part is kept as typed
/// (`~/So` gives `~/Sources/`). Hidden entries only when asked for by a
/// leading dot. Directories first, then by name.
pub fn completions(home: &Path, partial: &str) -> Vec<String> {
    let p = partial.trim_start();
    let (dir_part, prefix) = match p.rfind('/') {
        Some(i) => (&p[..=i], &p[i + 1..]),
        None if p == "~" => ("~/", ""),
        None => ("", p),
    };
    let dir = home_path(home, if dir_part.is_empty() { "~" } else { dir_part });
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut found: Vec<(bool, String)> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            if !name.starts_with(prefix) || (name.starts_with('.') && !prefix.starts_with('.')) {
                return None;
            }
            // Follow symlinks: a link to a directory completes as one.
            let is_dir = std::fs::metadata(e.path())
                .map(|m| m.is_dir())
                .unwrap_or(false);
            Some((is_dir, name))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    found
        .into_iter()
        .take(COMPLETIONS_MAX)
        .map(|(is_dir, name)| format!("{}{}{}", dir_part, name, if is_dir { "/" } else { "" }))
        .collect()
}

/// `--to`, else `$FUDE_TO`.
pub fn wanted_machine(flag: Option<&str>) -> Option<String> {
    flag.map(str::to_string)
        .or_else(|| std::env::var(TO_ENV).ok())
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// Every Fude that answers (for `--check`).
pub fn connect_all(candidates: &[Candidate], to: Option<&str>) -> Result<Vec<Reached>, String> {
    let (guis, hello_for) = hello_maker();
    reachable(candidates, &guis, to, hello_for)
}

/// Connect, or explain why not. `candidates` are tried in order; when
/// several machines answer, the user picks.
pub fn connect(candidates: &[Candidate], to: Option<&str>) -> Result<Reached, String> {
    choose(connect_all(candidates, to)?)
}

/// Serve `paths` over `conn` until their tabs are closed. Returns the exit
/// code (`fude_core::wait::exit_code`).
pub fn serve(mut conn: Connected, paths: Vec<String>, announce: bool) -> i32 {
    let agent = Agent::new(&paths);
    if announce {
        eprintln!(
            "fude-cli: serving {} to Fude {} via {}",
            agent
                .roots()
                .iter()
                .map(|r| r.to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join(", "),
            conn.gui_version.as_deref().unwrap_or("?"),
            conn.via
        );
    }
    let (tx, rx) = mpsc::channel::<Event>();

    let (wtx, wrx) = mpsc::channel::<PathBuf>();
    let mut watcher = match Watcher::new(wtx) {
        Ok(w) => Some(w),
        Err(e) => {
            eprintln!("fude-cli: {} (changes on disk will not be reported)", e);
            None
        }
    };
    let changed_tx = tx.clone();
    thread::spawn(move || {
        for p in wrx {
            if changed_tx.send(Event::Changed(p)).is_err() {
                return;
            }
        }
    });

    let reader_tx = tx;
    let mut reader: Box<dyn BufRead + Send> =
        std::mem::replace(&mut conn.reader, Box::new(std::io::empty()));
    thread::spawn(move || {
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => {
                    let _ = reader_tx.send(Event::Eof);
                    return;
                }
                Ok(_) => {
                    if reader_tx.send(Event::Line(line.clone())).is_err() {
                        return;
                    }
                }
            }
        }
    });

    let open = Message::Open {
        paths: paths.clone(),
        wait: true,
        roots: Some(
            agent
                .roots()
                .iter()
                .map(|r| r.to_string_lossy().to_string())
                .collect(),
        ),
    };
    if conn
        .writer
        .write_all(ipc::encode(&open).as_bytes())
        .is_err()
    {
        eprintln!("fude-cli: connection lost before the GUI could open anything");
        return 2;
    }
    let _ = conn.writer.flush();

    let mut state = WaitState::new(paths.len());
    let mut noop = NoWatch;
    while !state.done() {
        let Ok(ev) = rx.recv() else { break };
        let reply = match ev {
            Event::Line(line) => match ipc::decode(&line) {
                Ok(Some(msg)) => {
                    if let Some(text) = state.handle(&msg) {
                        eprintln!("{}", text);
                    }
                    let side: &mut dyn Side = match watcher.as_mut() {
                        Some(w) => w,
                        None => &mut noop,
                    };
                    agent.handle(&msg, side)
                }
                Ok(None) => None,
                Err(e) => {
                    eprintln!("fude-cli: {}", e);
                    None
                }
            },
            Event::Changed(p) => Some(Message::FileChanged {
                path: p.to_string_lossy().to_string(),
            }),
            Event::Eof => {
                state.disconnected();
                None
            }
        };
        if let Some(m) = reply {
            if conn.writer.write_all(ipc::encode(&m).as_bytes()).is_err() {
                state.disconnected();
            }
            let _ = conn.writer.flush();
        }
    }
    let _ = conn.writer.write_all(ipc::encode(&Message::Bye).as_bytes());
    exit_code(&state.outcomes())
}

struct NoWatch;
impl Side for NoWatch {
    fn before_write(&mut self, _path: &Path) {}
    fn watch(&mut self, _path: &Path) -> Result<(), String> {
        Err("file watching unavailable".into())
    }
    fn unwatch(&mut self, _path: &Path) -> Result<(), String> {
        Ok(())
    }
}

/// Re-run ourselves detached so the shell gets its prompt back while the
/// agent keeps serving files. Output goes to the log file.
pub fn detach(args: &Args, log: &Path, via: &Candidate) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if let Some(dir) = log.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let open_log = || {
        std::fs::File::options()
            .create(true)
            .append(true)
            .open(log)
            .map_err(|e| format!("cannot open {}: {}", log.display(), e))
    };
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--_foreground");
    if args.gui {
        cmd.arg("--gui");
    }
    cmd.arg("--");
    cmd.args(&args.paths);
    // The child must reach the Fude this process settled on, not go looking
    // again: it has no terminal to ask on.
    match via {
        Candidate::Tcp(addr) => cmd.env(discover::ADDR_ENV, addr),
        Candidate::Socket(path) => cmd.env(ipc::SOCKET_ENV, path),
        Candidate::Stdio => &mut cmd, // never detached: the pipe is the link
    };
    cmd.env_remove(TO_ENV);
    cmd.stdin(std::process::Stdio::null())
        .stdout(open_log()?)
        .stderr(open_log()?);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gui(port: u16, name: &str) -> crate::guis::Gui {
        crate::guis::Gui {
            port,
            token: format!("tok-{}", port),
            name: name.into(),
        }
    }

    #[cfg(unix)]
    #[test]
    fn here_reads_paths_from_the_home_directory() {
        let home = Path::new("/home/u");
        assert_eq!(home_path(home, "~"), PathBuf::from("/home/u"));
        assert_eq!(home_path(home, " "), PathBuf::from("/home/u"));
        assert_eq!(
            home_path(home, "~/notes/a.md"),
            PathBuf::from("/home/u/notes/a.md")
        );
        assert_eq!(home_path(home, "notes"), PathBuf::from("/home/u/notes"));
        assert_eq!(home_path(home, "/srv/docs"), PathBuf::from("/srv/docs"));
        // `~user` is not expanded: it is a name under home, as typed.
        assert_eq!(home_path(home, "~root"), PathBuf::from("/home/u/~root"));
    }

    #[test]
    fn hex_carries_any_path_and_refuses_what_is_not_hex() {
        assert_eq!(unhex("7e2f6e6f746573").unwrap(), "~/notes");
        assert_eq!(unhex(" 7E2F ").unwrap(), "~/");
        assert_eq!(unhex("").unwrap(), "");
        assert_eq!(unhex("e697a5e69cac2061").unwrap(), "日本 a");
        assert!(unhex("7e2").is_err());
        assert!(unhex("zz").is_err());
        assert!(unhex("ff").is_err()); // not UTF-8
    }

    #[cfg(unix)]
    #[test]
    fn completions_list_what_a_partial_path_could_become() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path();
        for d in ["Sources/fude", "Sandbox", ".config", "notes dir"] {
            std::fs::create_dir_all(home.join(d)).unwrap();
        }
        for f in ["Summary.md", ".bashrc", "Sources/readme.md"] {
            std::fs::write(home.join(f), "").unwrap();
        }
        std::os::unix::fs::symlink(home.join("Sources"), home.join("Slink")).unwrap();
        // Directories first, each with its slash; the typed prefix is kept.
        assert_eq!(
            completions(home, "~/S"),
            ["~/Sandbox/", "~/Slink/", "~/Sources/", "~/Summary.md"]
        );
        assert_eq!(
            completions(home, "~/Sources/"),
            ["~/Sources/fude/", "~/Sources/readme.md"]
        );
        // Relative means under home, as `here` reads it.
        assert_eq!(completions(home, "So"), ["Sources/"]);
        assert_eq!(completions(home, "Sources/f"), ["Sources/fude/"]);
        // Nothing typed, or just `~`: what is in home, hidden entries aside.
        let top = ["Sandbox/", "Slink/", "Sources/", "notes dir/", "Summary.md"];
        assert_eq!(completions(home, ""), top);
        assert_eq!(completions(home, "~"), top.map(|t| format!("~/{t}")));
        // Hidden ones on request.
        assert_eq!(completions(home, "~/."), ["~/.config/", "~/.bashrc"]);
        // Absolute paths work the same way.
        let abs = format!("{}/Sources/", home.display());
        assert_eq!(
            completions(home, &abs),
            [format!("{abs}fude/"), format!("{abs}readme.md")]
        );
        // No such directory, or a file used as one: nothing, not an error.
        assert_eq!(completions(home, "~/nope/x"), Vec::<String>::new());
        assert_eq!(completions(home, "~/Summary.md/"), Vec::<String>::new());
    }

    #[test]
    fn a_machine_is_picked_by_name_or_port() {
        let guis = [gui(47900, "home-wsl"), gui(48000, "gpdmd"), gui(48100, "")];
        assert_eq!(pick_named(&guis, "GPDMD").unwrap().port, 48000);
        assert_eq!(pick_named(&guis, " home-wsl ").unwrap().port, 47900);
        assert_eq!(pick_named(&guis, "48100").unwrap().port, 48100);
        let e = pick_named(&guis, "laptop").unwrap_err();
        assert!(
            e.contains("'laptop'") && e.contains("home-wsl, gpdmd, port 48100"),
            "{e}"
        );
        let e = pick_named(&[], "laptop").unwrap_err();
        assert!(e.contains("fude setup"), "{e}");
    }

    #[test]
    fn the_answer_to_which_one_is_a_number_in_range() {
        assert_eq!(parse_choice("1\n", 2), Some(0));
        assert_eq!(parse_choice(" 2 ", 2), Some(1));
        assert_eq!(parse_choice("\n", 2), Some(0));
        assert_eq!(parse_choice("0", 2), None);
        assert_eq!(parse_choice("3", 2), None);
        assert_eq!(parse_choice("gpdmd", 2), None);
        assert_eq!(parse_choice("", 0), None);
    }

    /// A Fude that welcomes whoever connects, `times` times, on its own port.
    fn fake_fude(version: &'static str, times: usize) -> (u16, thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            for _ in 0..times {
                let (stream, _) = listener.accept().unwrap();
                let mut r = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                r.read_line(&mut line).unwrap();
                let mut w = stream;
                w.write_all(
                    ipc::encode(&Message::Welcome {
                        protocol: PROTOCOL_VERSION,
                        gui_version: Some(version.into()),
                    })
                    .as_bytes(),
                )
                .unwrap();
            }
        });
        (port, server)
    }

    fn plain_hello(_: &Candidate) -> Message {
        Message::Hello {
            protocol: PROTOCOL_VERSION,
            cwd: None,
            cli_version: None,
            host: None,
            token: None,
        }
    }

    fn tcp(port: u16) -> Candidate {
        Candidate::Tcp(format!("127.0.0.1:{}", port))
    }

    #[test]
    fn every_registered_machine_that_answers_is_offered() {
        let (a, sa) = fake_fude("a", 1);
        let (b, sb) = fake_fude("b", 1);
        // One more is registered but its forward is down.
        let dead = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        // The shared port answers too, yet is not asked: machines answered.
        let (shared, _never) = fake_fude("shared", 1);
        let guis = [gui(a, "home-wsl"), gui(dead, "laptop"), gui(b, "gpdmd")];
        let cands = [tcp(a), tcp(dead), tcp(b), tcp(shared)];
        let got = reachable(&cands, &guis, None, plain_hello).unwrap();
        let names: Vec<_> = got.iter().map(|r| r.name.clone().unwrap()).collect();
        assert_eq!(names, ["home-wsl", "gpdmd"]);
        assert_eq!(got[1].describe(), "Fude b on gpdmd");
        sa.join().unwrap();
        sb.join().unwrap();
    }

    #[test]
    fn naming_a_machine_asks_only_that_one() {
        let (b, sb) = fake_fude("b", 1);
        // `a` is registered and would answer, but must not even be dialled:
        // its listener is never accepted on.
        let quiet = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let a = quiet.local_addr().unwrap().port();
        let guis = [gui(a, "home-wsl"), gui(b, "gpdmd")];
        let cands = [tcp(a), tcp(b)];
        let got = reachable(&cands, &guis, Some("gpdmd"), plain_hello).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name.as_deref(), Some("gpdmd"));
        sb.join().unwrap();
        quiet.set_nonblocking(true).unwrap();
        assert!(quiet.accept().is_err(), "the other machine was contacted");
        // An unknown name is an error, not a fallback to somebody's Fude.
        let e = reachable(&cands, &guis, Some("laptop"), plain_hello).unwrap_err();
        assert!(e.contains("known: home-wsl, gpdmd"), "{e}");
    }

    #[test]
    fn without_registered_answers_the_older_routes_still_work() {
        let (shared, ss) = fake_fude("shared", 1);
        let dead = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let guis = [gui(dead, "gpdmd")];
        let got = reachable(&[tcp(dead), tcp(shared)], &guis, None, plain_hello).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, None);
        assert_eq!(
            got[0].describe(),
            format!("Fude shared via tcp://127.0.0.1:{}", shared)
        );
        ss.join().unwrap();
        // Nothing anywhere: every candidate's reason is reported.
        let e = reachable(&[tcp(dead)], &guis, None, plain_hello).unwrap_err();
        assert!(
            e.starts_with("no Fude GUI reachable:") && e.contains(&dead.to_string()),
            "{e}"
        );
    }

    #[test]
    fn each_machine_is_shown_its_own_token() {
        let guis = [crate::guis::Gui {
            port: 47900,
            token: "tok-home".into(),
            name: "home".into(),
        }];
        let mine = Candidate::Tcp("127.0.0.1:47900".into());
        let old = Candidate::Tcp("127.0.0.1:47821".into());
        let shared = Some("tok-shared".to_string());
        assert_eq!(
            token_for(&mine, &guis, None, shared.clone()).as_deref(),
            Some("tok-home")
        );
        // The shared port, and anything unregistered, keep the old token.
        assert_eq!(
            token_for(&old, &guis, None, shared.clone()).as_deref(),
            Some("tok-shared")
        );
        assert_eq!(token_for(&old, &guis, None, None), None);
        // An explicit token wins everywhere; a blank one is no token.
        assert_eq!(
            token_for(&mine, &guis, Some(" tok-env ".into()), shared.clone()).as_deref(),
            Some("tok-env")
        );
        assert_eq!(
            token_for(&mine, &guis, Some("  ".into()), shared).as_deref(),
            Some("tok-home")
        );
    }

    #[test]
    fn host_name_prefers_the_override() {
        std::env::set_var("FUDE_HOST", "box.example");
        assert_eq!(host_name(), "box.example");
        std::env::set_var("FUDE_HOST", "  ");
        assert_ne!(host_name(), "  ");
        std::env::remove_var("FUDE_HOST");
        assert!(!host_name().is_empty());
    }

    // `/abs/y.md` is only absolute on Unix.
    #[cfg(unix)]
    #[test]
    fn absolute_paths_resolve_relative_operands() {
        let cwd = std::env::current_dir().unwrap();
        let out = absolute_paths(&["x.md".into(), "/abs/y.md".into()]);
        assert_eq!(out[0], cwd.join("x.md").to_string_lossy());
        assert_eq!(out[1], "/abs/y.md");
    }

    #[test]
    fn log_path_lives_under_the_cache_dir() {
        assert_eq!(
            log_path(Path::new("/c")),
            PathBuf::from("/c/fude/agent.log")
        );
    }
}
