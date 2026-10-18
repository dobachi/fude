//! Opening a place on another machine from this window, directly.
//!
//! The app starts `fude-cli` over there itself — `ssh HOST fude-cli …`, or
//! `wsl.exe … fude-cli …` for the WSL distro — and speaks the usual agent
//! protocol over that process's stdin/stdout. Nothing has to be prepared
//! for this beyond `fude-cli` being there: no forwarded port, no token, no
//! entry in `~/.ssh/config`, no bridge. (Those remain what makes `fude FILE`
//! typed *on* the host reach this window; see docs/REMOTE.md.)

use crate::gui_server::{self, OpenSink, RemoteSessions, WaitRegistry};
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How long to wait for the far side to open the place before giving up.
const OPEN_TIMEOUT: Duration = Duration::from_secs(40);
/// How long a completion may take: it runs while the user types.
const COMPLETE_TIMEOUT_SECS: u32 = 5;

/// Where the place is.
#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    /// An ssh destination.
    Ssh(String),
    /// The WSL distro chosen for WSL integration (Windows).
    Wsl,
}

impl Target {
    /// How a session opened this way is labelled (`RemoteSession::origin`),
    /// so the frontend can open another place the same way.
    pub fn origin(&self) -> String {
        match self {
            Target::Ssh(host) => format!("ssh:{}", host),
            Target::Wsl => "wsl".to_string(),
        }
    }
}

/// `s` as hex. Paths travel like this: through ssh, the far shell and (on
/// Windows) wsl.exe, each with quoting rules of its own, hex needs none.
pub fn hex(s: &str) -> String {
    s.bytes().map(|b| format!("{:02x}", b)).collect()
}

/// What the far shell is asked to run: its `fude-cli` — the one setup put
/// in `~/.local/bin` first, else whatever is on PATH — with `words` and the
/// path. Built from characters no shell reads specially but `$`, which is
/// meant for it.
fn agent_command(words: &str, path: &str) -> String {
    format!(
        "PATH=$HOME/.local/bin:$PATH fude-cli {} --hex {}",
        words,
        hex(path)
    )
}

/// The same for the WSL distro, whose `fude-cli` is the one WSL integration
/// keeps in the cache for this app's version.
fn wsl_agent_command(version: &str, words: &str, path: &str) -> String {
    format!(
        "exec $HOME/.cache/fude/fude-cli-{} {} --hex {}",
        version,
        words,
        hex(path)
    )
}

/// The program and arguments that reach `target` and run `fude-cli words
/// --hex PATH` there. `wsl_distro` is the WSL integration distro when this
/// is Windows with integration on: ssh then runs inside it, where the
/// user's keys and ssh config live.
pub fn command_line(
    target: &Target,
    wsl_distro: Option<&str>,
    version: &str,
    words: &str,
    path: &str,
    connect_timeout: Option<u32>,
) -> Result<(String, Vec<String>), String> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    match target {
        Target::Ssh(host) => {
            // Batch mode: nobody can answer a prompt here. An existing
            // shared connection is used when there is one, but this
            // process neither becomes one nor sets up forwards — it is
            // only a pipe to the agent. It asks the far side every 15s
            // whether it is still there: an idle link that died (sleep, a
            // changed network) is then noticed in under a minute — and
            // reconnected — instead of at the next save.
            let mut ssh = s(&[
                "ssh",
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ControlMaster=no",
                "-o",
                "ClearAllForwardings=yes",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
            ]);
            if let Some(secs) = connect_timeout {
                ssh.extend(s(&["-o", &format!("ConnectTimeout={}", secs)]));
            }
            ssh.push(host.clone());
            ssh.push(agent_command(words, path));
            Ok(match wsl_distro {
                Some(distro) => {
                    let mut args = s(&["-d", distro, "-e"]);
                    args.extend(ssh);
                    ("wsl.exe".to_string(), args)
                }
                None => {
                    let program = ssh.remove(0);
                    (program, ssh)
                }
            })
        }
        Target::Wsl => {
            let distro = wsl_distro.ok_or("WSL 連携でディストリビューションを選んでください")?;
            let mut args = s(&["-d", distro, "-e", "sh", "-c"]);
            args.push(wsl_agent_command(version, words, path));
            Ok(("wsl.exe".to_string(), args))
        }
    }
}

/// What to add to the far side's own words when they show its `fude-cli`
/// is missing or predates this way of connecting.
pub fn failure_hint(target: &Target, log: &str) -> Option<String> {
    let l = log.to_ascii_lowercase();
    let missing = l.contains("fude-cli: not found")
        || l.contains("fude-cli: command not found")
        || l.contains("no such file or directory") && l.contains("fude-cli-");
    let old = l.contains("unknown option") || l.contains("nothing to open");
    if !(missing || old) {
        return None;
    }
    Some(match target {
        Target::Ssh(host) => format!(
            "{} の fude-cli が{}。下の「端末から開くための設定」で {} を「セットアップ」（登録済みなら「更新」）すると入ります。",
            host,
            if missing { "ありません" } else { "古い版です" },
            host
        ),
        Target::Wsl => "WSL の中に、この版の fude-cli がまだありません。「WSL 連携」でディストリビューションを選び直すと入ります。".to_string(),
    })
}

/// How an attempt to open ended.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// The place is open in the window; the connection lives on.
    Opened,
    /// The far side gave up; this is what it said.
    Failed(String),
}

/// The waits between attempts to bring back a connection whose link broke:
/// soon at first (a blip), then once a minute, for about half an hour
/// (long enough for a short sleep or a network change), then given up.
pub fn reconnect_delays() -> Vec<Duration> {
    let mut d: Vec<Duration> = [1, 2, 4, 8, 15, 30]
        .iter()
        .map(|s| Duration::from_secs(*s))
        .collect();
    d.extend(std::iter::repeat_n(Duration::from_secs(60), 28));
    d
}

/// Sits between the connection and the real sink. Tells the waiting
/// command that the agent opened something; when `quiet` (bringing a
/// connection back) it does not open it again — it is open already. The
/// end of the connection is held back (`gone`) so that the caller can say
/// whether it is over or being brought back.
struct Notify {
    inner: Arc<dyn OpenSink>,
    opened: Mutex<Option<mpsc::Sender<()>>>,
    quiet: bool,
    gone: Mutex<Option<String>>,
}

impl OpenSink for Notify {
    fn open(&self, path: &str, wait: bool) -> Result<(), String> {
        let r = if self.quiet {
            Ok(())
        } else {
            self.inner.open(path, wait)
        };
        if r.is_ok() {
            if let Some(tx) = self.opened.lock().ok().and_then(|mut o| o.take()) {
                let _ = tx.send(());
            }
        }
        r
    }
    fn file_changed(&self, path: &str) {
        self.inner.file_changed(path)
    }
    fn dir_changed(&self, path: &str) {
        self.inner.dir_changed(path)
    }
    fn disconnected(&self, host: &str) {
        if let Ok(mut g) = self.gone.lock() {
            *g = Some(host.to_string());
        }
    }
    fn cli_outdated(&self, host: &str, cli_version: &str) {
        self.inner.cli_outdated(host, cli_version)
    }
}

/// Everything needed to start the agent again.
struct Plan {
    program: String,
    args: Vec<String>,
    origin: String,
    registry: Arc<WaitRegistry>,
    sessions: Arc<RemoteSessions>,
    sink: Arc<dyn OpenSink>,
    timeout: Duration,
    retry: Vec<Duration>,
}

/// Start `program args…`, serve the agent it becomes, and wait until it
/// has opened its place (or failed to). On success the process stays,
/// serving the tabs, until the connection ends — the user disconnects, the
/// app exits, or the far side goes away — and is then reaped. If the link
/// breaks (the far side vanishes without a goodbye), it is started again
/// quietly, as `reconnect_delays` says, so the open tabs can be saved again.
pub fn open(
    program: &str,
    args: &[String],
    origin: &str,
    registry: Arc<WaitRegistry>,
    sessions: Arc<RemoteSessions>,
    sink: Arc<dyn OpenSink>,
    timeout: Option<Duration>,
) -> Result<Outcome, String> {
    open_with(
        program,
        args,
        origin,
        registry,
        sessions,
        sink,
        timeout,
        reconnect_delays(),
    )
}

/// `open`, with the waits between attempts to bring a broken link back.
#[allow(clippy::too_many_arguments)]
pub fn open_with(
    program: &str,
    args: &[String],
    origin: &str,
    registry: Arc<WaitRegistry>,
    sessions: Arc<RemoteSessions>,
    sink: Arc<dyn OpenSink>,
    timeout: Option<Duration>,
    retry: Vec<Duration>,
) -> Result<Outcome, String> {
    let plan = Arc::new(Plan {
        program: program.to_string(),
        args: args.to_vec(),
        origin: origin.to_string(),
        registry,
        sessions,
        sink,
        timeout: timeout.unwrap_or(OPEN_TIMEOUT),
        retry,
    });
    attempt(plan, false)
}

/// Bring back the connection to `host` that `plan` made, quietly; tell the
/// window how that went.
fn reconnect(plan: Arc<Plan>, host: String) {
    plan.sink.reconnecting(&host);
    for wait in plan.retry.clone() {
        std::thread::sleep(wait);
        if let Ok(Outcome::Opened) = attempt(Arc::clone(&plan), true) {
            plan.sink.reconnected(&host);
            return;
        }
    }
    plan.sink.reconnect_failed(&host);
}

fn attempt(plan: Arc<Plan>, quiet: bool) -> Result<Outcome, String> {
    let mut cmd = Command::new(&plan.program);
    cmd.args(&plan.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::wsl_bridge::no_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{} を実行できません: {}", plan.program, e))?;
    let (Some(stdin), Some(stdout), Some(mut stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        let _ = child.kill();
        return Err("子プロセスに繋げません".into());
    };

    // What the far side says on stderr: the reason, when it fails.
    let said = Arc::new(Mutex::new(String::new()));
    let said_w = Arc::clone(&said);
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = stderr.read(&mut buf) {
            if n == 0 {
                break;
            }
            if let Ok(mut s) = said_w.lock() {
                if s.len() < 64 * 1024 {
                    s.push_str(&String::from_utf8_lossy(&buf[..n]));
                }
            }
        }
    });

    let (opened_tx, opened_rx) = mpsc::channel::<()>();
    let (ended_tx, ended_rx) = mpsc::channel::<()>();
    let notify = Arc::new(Notify {
        inner: Arc::clone(&plan.sink),
        opened: Mutex::new(Some(opened_tx)),
        quiet,
        gone: Mutex::new(None),
    });
    let child: Arc<Mutex<Child>> = Arc::new(Mutex::new(child));
    let child_s = Arc::clone(&child);
    let plan_s = Arc::clone(&plan);
    std::thread::Builder::new()
        .name("fude-remote-direct".into())
        .spawn(move || {
            let end = gui_server::serve_child(
                Box::new(stdout),
                Box::new(stdin),
                plan_s.origin.clone(),
                Arc::clone(&plan_s.registry),
                Arc::clone(&plan_s.sessions),
                notify.clone(),
            );
            // The conversation is over, whoever ended it. The agent has
            // been told goodbye and its stdin is closed, so it leaves by
            // itself; one that does not is ended, so that nothing is left
            // behind on either side.
            if let Ok(mut c) = child_s.lock() {
                for _ in 0..40 {
                    if !matches!(c.try_wait(), Ok(None)) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                let _ = c.kill();
                let _ = c.wait();
            }
            let _ = ended_tx.send(());
            // A place was being served: either that is over, or the link
            // broke and it is brought back.
            let gone = notify.gone.lock().ok().and_then(|mut g| g.take());
            if let Some(host) = gone {
                if end == gui_server::End::Lost && !plan_s.retry.is_empty() {
                    reconnect(plan_s, host);
                } else {
                    plan_s.sink.disconnected(&host);
                }
            }
        })
        .map_err(|e| e.to_string())?;

    let said_now = || {
        said.lock()
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    };
    let deadline = std::time::Instant::now() + plan.timeout;
    loop {
        if opened_rx.try_recv().is_ok() {
            return Ok(Outcome::Opened);
        }
        match ended_rx.recv_timeout(Duration::from_millis(50)) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => {
                // It may have opened and ended in the same instant.
                if opened_rx.try_recv().is_ok() {
                    return Ok(Outcome::Opened);
                }
                // stderr is drained by its own thread; give it a moment.
                std::thread::sleep(Duration::from_millis(100));
                let said = said_now();
                return Ok(Outcome::Failed(if said.is_empty() {
                    "接続が、何も開かないまま終わりました".to_string()
                } else {
                    said
                }));
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        if std::time::Instant::now() >= deadline {
            if let Ok(mut c) = child.lock() {
                let _ = c.kill();
            }
            let said = said_now();
            return Ok(Outcome::Failed(format!(
                "時間内に開けませんでした{}",
                if said.is_empty() {
                    String::new()
                } else {
                    format!("\n{}", said)
                }
            )));
        }
    }
}

/// Run a completion query and return its lines; empty on any failure
/// (completion is a convenience, never an error to show).
pub fn complete(program: &str, args: &[String]) -> Vec<String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stderr(Stdio::null());
    crate::wsl_bridge::no_window(&mut cmd);
    match cmd.output() {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| l.trim_end_matches('\r').to_string())
            .filter(|l| !l.is_empty() && !l.chars().any(|c| c.is_control()))
            .collect(),
        _ => Vec::new(),
    }
}

pub fn complete_timeout() -> u32 {
    COMPLETE_TIMEOUT_SECS
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn hex_needs_no_quoting_whatever_the_path() {
        assert_eq!(hex("~/notes"), "7e2f6e6f746573");
        assert_eq!(hex(""), "");
        assert_eq!(hex("a'b \"c\" $(x)"), "612762202263222024287829");
        assert!(hex("日本 語/メモ.md")
            .bytes()
            .all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn ssh_is_asked_for_a_bare_pipe_to_the_agent() {
        let (program, args) = command_line(
            &Target::Ssh("me@k16".into()),
            None,
            "0.9.0",
            "here --_stdio",
            "~/a b",
            None,
        )
        .unwrap();
        assert_eq!(program, "ssh");
        assert_eq!(
            args,
            s(&[
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ControlMaster=no",
                "-o",
                "ClearAllForwardings=yes",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                "me@k16",
                "PATH=$HOME/.local/bin:$PATH fude-cli here --_stdio --hex 7e2f612062",
            ])
        );
    }

    #[test]
    fn with_wsl_integration_ssh_runs_inside_the_distro() {
        let (program, args) = command_line(
            &Target::Ssh("k16".into()),
            Some("Ubuntu-22.04"),
            "0.9.0",
            "complete",
            "~/S",
            Some(5),
        )
        .unwrap();
        assert_eq!(program, "wsl.exe");
        assert_eq!(
            &args[..4],
            s(&["-d", "Ubuntu-22.04", "-e", "ssh"]).as_slice()
        );
        assert!(args.contains(&"ConnectTimeout=5".to_string()));
        assert_eq!(
            args.last().unwrap(),
            "PATH=$HOME/.local/bin:$PATH fude-cli complete --hex 7e2f53"
        );
    }

    #[test]
    fn the_distro_itself_is_reached_without_ssh() {
        let (program, args) = command_line(
            &Target::Wsl,
            Some("Ubuntu"),
            "0.9.0",
            "here --_stdio",
            "~",
            None,
        )
        .unwrap();
        assert_eq!(program, "wsl.exe");
        assert_eq!(
            args,
            s(&[
                "-d",
                "Ubuntu",
                "-e",
                "sh",
                "-c",
                "exec $HOME/.cache/fude/fude-cli-0.9.0 here --_stdio --hex 7e",
            ])
        );
        // Without a distro there is nowhere to go.
        assert!(command_line(&Target::Wsl, None, "0.9.0", "here --_stdio", "~", None).is_err());
    }

    #[test]
    fn a_missing_or_old_agent_gets_a_way_forward() {
        let k16 = Target::Ssh("k16".into());
        let h = failure_hint(&k16, "bash: line 1: fude-cli: command not found").unwrap();
        assert!(
            h.contains("ありません") && h.contains("セットアップ"),
            "{h}"
        );
        let h = failure_hint(&k16, "fude-cli: unknown option '--_stdio'").unwrap();
        assert!(h.contains("古い版") && h.contains("更新"), "{h}");
        let h = failure_hint(
            &Target::Wsl,
            "sh: 1: exec: /home/u/.cache/fude/fude-cli-0.9.0: not found\nNo such file or directory: fude-cli-0.9.0",
        )
        .unwrap();
        assert!(h.contains("WSL 連携"), "{h}");
        // Anything else is the far side's own, complete, explanation.
        assert_eq!(
            failure_hint(&k16, "fude-cli: /nope: no such file or directory"),
            None
        );
        assert_eq!(failure_hint(&k16, "Permission denied (publickey)."), None);
    }

    /// A stand-in agent: a shell script that speaks just enough protocol.
    /// It is the argument of `sh` (see `SH`) rather than run by itself: a
    /// file just written cannot be executed while a process forked by a
    /// test running beside this one still holds it open ("Text file busy").
    #[cfg(unix)]
    fn agent_script(body: &str) -> (tempfile::TempDir, Vec<String>) {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("agent.sh");
        std::fs::write(&path, format!("{}\n", body)).unwrap();
        let p = path.to_string_lossy().to_string();
        (tmp, vec![p])
    }

    #[cfg(unix)]
    const SH: &str = "sh";

    #[derive(Default)]
    struct Recorder {
        opened: Mutex<Vec<String>>,
        gone: Mutex<Vec<String>>,
        reconnecting: Mutex<Vec<String>>,
        reconnected: Mutex<Vec<String>>,
        failed: Mutex<Vec<String>>,
    }
    impl OpenSink for Recorder {
        fn open(&self, path: &str, _wait: bool) -> Result<(), String> {
            self.opened.lock().unwrap().push(path.to_string());
            Ok(())
        }
        fn disconnected(&self, host: &str) {
            self.gone.lock().unwrap().push(host.to_string());
        }
        fn reconnecting(&self, host: &str) {
            self.reconnecting.lock().unwrap().push(host.to_string());
        }
        fn reconnected(&self, host: &str) {
            self.reconnected.lock().unwrap().push(host.to_string());
        }
        fn reconnect_failed(&self, host: &str) {
            self.failed.lock().unwrap().push(host.to_string());
        }
    }

    /// Wait (up to 5s) for `cond`.
    fn eventually(cond: impl Fn() -> bool) -> bool {
        for _ in 0..250 {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        cond()
    }

    const FAST: [Duration; 3] = [
        Duration::from_millis(10),
        Duration::from_millis(10),
        Duration::from_millis(10),
    ];

    #[test]
    fn reconnecting_starts_soon_backs_off_and_gives_up_after_a_while() {
        let d = reconnect_delays();
        assert_eq!(d[0], Duration::from_secs(1));
        assert!(d.windows(2).all(|w| w[0] <= w[1]), "never sooner again");
        assert!(d.iter().all(|x| *x <= Duration::from_secs(60)));
        let total: Duration = d.iter().sum();
        assert!(
            total >= Duration::from_secs(20 * 60) && total <= Duration::from_secs(40 * 60),
            "{total:?}"
        );
    }

    /// The first run opens and then drops (as when the link dies); every
    /// later run opens and stays.
    #[cfg(unix)]
    const DROPS_ONCE: &str = r#"echo '{"type":"hello","protocol":1,"host":"k16"}'
read welcome
echo '{"type":"open","paths":["/home/u/a.md"],"wait":true,"roots":["/home/u"]}'
if [ ! -e "$0.first" ]; then : > "$0.first"; exit 0; fi
while read line; do
  case "$line" in *'"bye"'*) exit 0;; esac
done"#;

    #[cfg(unix)]
    #[test]
    fn a_dropped_agent_is_reconnected_quietly() {
        let (_tmp, script) = agent_script(DROPS_ONCE);
        let sessions = Arc::new(RemoteSessions::default());
        let sink = Arc::new(Recorder::default());
        let outcome = open_with(
            SH,
            &script,
            "ssh:k16",
            Arc::new(WaitRegistry::default()),
            Arc::clone(&sessions),
            sink.clone(),
            Some(Duration::from_secs(10)),
            FAST.to_vec(),
        )
        .unwrap();
        assert_eq!(outcome, Outcome::Opened);
        assert!(eventually(|| sink.reconnected.lock().unwrap().len() == 1));
        assert_eq!(sink.reconnecting.lock().unwrap().as_slice(), ["k16"]);
        assert_eq!(sink.reconnected.lock().unwrap().as_slice(), ["k16"]);
        // The place is not opened a second time, and the drop is not
        // reported as the end of the connection.
        assert_eq!(
            sink.opened.lock().unwrap().as_slice(),
            ["remote://k16/home/u/a.md"]
        );
        assert!(sink.gone.lock().unwrap().is_empty());
        let listed = sessions.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].3.as_deref(), Some("ssh:k16"));

        // Hung up on, it ends for good.
        assert!(sessions.hang_up(listed[0].0));
        assert!(eventually(|| sink.gone.lock().unwrap().len() == 1));
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(sink.reconnecting.lock().unwrap().len(), 1);
        assert!(sessions.list().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn reconnecting_gives_up_when_the_host_stays_away() {
        let (_tmp, script) = agent_script(
            r#"if [ -e "$0.first" ]; then echo 'ssh: connect to host k16: timed out' >&2; exit 255; fi
: > "$0.first"
echo '{"type":"hello","protocol":1,"host":"k16"}'
read welcome
echo '{"type":"open","paths":["/home/u"],"wait":true,"roots":["/home/u"]}'
exit 0"#,
        );
        let sink = Arc::new(Recorder::default());
        open_with(
            SH,
            &script,
            "ssh:k16",
            Arc::new(WaitRegistry::default()),
            Arc::new(RemoteSessions::default()),
            sink.clone(),
            Some(Duration::from_secs(10)),
            FAST.to_vec(),
        )
        .unwrap();
        assert!(eventually(|| sink.failed.lock().unwrap().len() == 1));
        assert_eq!(sink.failed.lock().unwrap().as_slice(), ["k16"]);
        assert!(sink.reconnected.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn an_agent_that_says_goodbye_is_not_called_back() {
        let (_tmp, script) = agent_script(
            r#"echo '{"type":"hello","protocol":1,"host":"k16"}'
read welcome
echo '{"type":"open","paths":["/home/u"],"wait":true,"roots":["/home/u"]}'
echo '{"type":"bye"}'
exit 0"#,
        );
        let sink = Arc::new(Recorder::default());
        open_with(
            SH,
            &script,
            "ssh:k16",
            Arc::new(WaitRegistry::default()),
            Arc::new(RemoteSessions::default()),
            sink.clone(),
            Some(Duration::from_secs(10)),
            FAST.to_vec(),
        )
        .unwrap();
        assert!(eventually(|| sink.gone.lock().unwrap().len() == 1));
        std::thread::sleep(Duration::from_millis(100));
        assert!(sink.reconnecting.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_started_agent_opens_its_place_stays_and_can_be_hung_up_on() {
        // Greets, opens, then stays until told goodbye — and records that
        // it was ended rather than left running.
        let (tmp, script) = agent_script(
            r#"echo '{"type":"hello","protocol":1,"host":"k16"}'
read welcome
echo '{"type":"open","paths":["/home/u/notes"],"wait":true,"roots":["/home/u/notes"]}'
while read line; do
  case "$line" in *'"bye"'*) echo bye > "$0.ended"; exit 0;; esac
done"#,
        );
        let registry = Arc::new(WaitRegistry::default());
        let sessions = Arc::new(RemoteSessions::default());
        let sink = Arc::new(Recorder::default());
        let outcome = open(
            SH,
            &script,
            "ssh:k16",
            Arc::clone(&registry),
            Arc::clone(&sessions),
            sink.clone(),
            Some(Duration::from_secs(10)),
        )
        .unwrap();
        assert_eq!(outcome, Outcome::Opened);
        assert_eq!(
            sink.opened.lock().unwrap().as_slice(),
            ["remote://k16/home/u/notes"]
        );
        let listed = sessions.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].1, "k16");
        assert_eq!(listed[0].3.as_deref(), Some("ssh:k16"));
        assert_eq!(Target::Ssh("me@k16".into()).origin(), "ssh:me@k16");
        assert_eq!(Target::Wsl.origin(), "wsl");

        assert!(sessions.hang_up(listed[0].0));
        let ended = tmp.path().join("agent.sh.ended");
        for _ in 0..100 {
            if ended.exists() && sessions.list().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(ended.exists(), "the agent was not told goodbye");
        assert!(sessions.list().is_empty());
        assert!(eventually(|| sink.gone.lock().unwrap().len() == 1));
        assert_eq!(sink.gone.lock().unwrap().as_slice(), ["k16"]);
        // Ended on purpose: not called back.
        assert!(sink.reconnecting.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn an_agent_that_gives_up_reports_what_it_said() {
        let (_tmp, script) =
            agent_script("echo 'fude-cli: /nope: no such file or directory' >&2; exit 2");
        let outcome = open(
            SH,
            &script,
            "ssh:k16",
            Arc::new(WaitRegistry::default()),
            Arc::new(RemoteSessions::default()),
            Arc::new(Recorder::default()),
            Some(Duration::from_secs(10)),
        )
        .unwrap();
        assert_eq!(
            outcome,
            Outcome::Failed("fude-cli: /nope: no such file or directory".into())
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_agent_that_never_opens_is_given_up_on_and_ended() {
        let (tmp, script) = agent_script(
            r#"trap 'echo killed > "$0.ended"' TERM
echo 'still thinking' >&2
sleep 30"#,
        );
        let sessions = Arc::new(RemoteSessions::default());
        let started = std::time::Instant::now();
        let outcome = open(
            SH,
            &script,
            "ssh:k16",
            Arc::new(WaitRegistry::default()),
            Arc::clone(&sessions),
            Arc::new(Recorder::default()),
            Some(Duration::from_millis(400)),
        )
        .unwrap();
        assert!(started.elapsed() < Duration::from_secs(10));
        match outcome {
            Outcome::Failed(why) => {
                assert!(
                    why.contains("時間内に") && why.contains("still thinking"),
                    "{why}"
                )
            }
            other => panic!("{other:?}"),
        }
        assert!(sessions.list().is_empty());
        drop(tmp);
    }

    /// The bundled fude-cli, when the sidecar has been built (`make test`
    /// and CI do that first).
    fn sidecar() -> Option<std::path::PathBuf> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        std::fs::read_dir(dir)
            .ok()?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("fude-cli"))
            })
    }

    /// The real agent against the real server, over real pipes: what the
    /// stand-ins above each cover one half of.
    #[cfg(unix)]
    #[test]
    fn the_real_fude_cli_opens_a_folder_over_its_stdio() {
        let Some(cli) = sidecar() else {
            eprintln!("skipped: no bundled fude-cli (run scripts/sidecar.sh)");
            return;
        };
        let home = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(home.path().join("my notes")).unwrap();
        std::fs::write(home.path().join("my notes/a.md"), "# a").unwrap();
        // HOME decides what `~` means for the agent; the env reaches the
        // child because `open` inherits it.
        let wrapper = home.path().join("run.sh");
        std::fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\nHOME='{}' FUDE_HOST=farbox exec '{}' here --_stdio --hex {}\n",
                home.path().display(),
                cli.display(),
                hex("~/my notes")
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();

        let sessions = Arc::new(RemoteSessions::default());
        let sink = Arc::new(Recorder::default());
        let outcome = open(
            &wrapper.to_string_lossy(),
            &[],
            "ssh:farbox",
            Arc::new(WaitRegistry::default()),
            Arc::clone(&sessions),
            sink.clone(),
            Some(Duration::from_secs(20)),
        )
        .unwrap();
        assert_eq!(outcome, Outcome::Opened);
        let dir = format!("{}/my notes", home.path().display());
        assert_eq!(
            sink.opened.lock().unwrap().as_slice(),
            [format!("remote://farbox{}", dir)]
        );
        let listed = sessions.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].2, std::slice::from_ref(&dir));
        // The agent answers for its files over the same pipe.
        let (session, path) = sessions
            .lookup(&format!("remote://farbox{}/a.md", dir))
            .unwrap();
        let reply = session
            .request(|id| fude_core::ipc::Message::ReadFile {
                id,
                path: path.clone(),
                base64: false,
            })
            .unwrap();
        assert_eq!(reply.as_str(), Some("# a"), "{reply}");
        // And leaves when hung up on.
        assert!(sessions.hang_up(listed[0].0));
        for _ in 0..150 {
            if sessions.list().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(sessions.list().is_empty());

        // A place that is not there is refused with the agent's own words.
        std::fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\nHOME='{}' exec '{}' here --_stdio --hex {}\n",
                home.path().display(),
                cli.display(),
                hex("~/nope")
            ),
        )
        .unwrap();
        let outcome = open(
            &wrapper.to_string_lossy(),
            &[],
            "ssh:farbox",
            Arc::new(WaitRegistry::default()),
            Arc::new(RemoteSessions::default()),
            Arc::new(Recorder::default()),
            Some(Duration::from_secs(20)),
        )
        .unwrap();
        match outcome {
            Outcome::Failed(why) => assert!(why.contains("no such file or directory"), "{why}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn something_that_cannot_be_run_is_an_error() {
        let r = open(
            "/no/such/program-zz",
            &[],
            "wsl",
            Arc::new(WaitRegistry::default()),
            Arc::new(RemoteSessions::default()),
            Arc::new(Recorder::default()),
            None,
        );
        assert!(r.unwrap_err().contains("実行できません"));
    }

    #[cfg(unix)]
    #[test]
    fn completions_are_the_lines_printed_or_nothing() {
        let (_t, ok) = agent_script("printf '~/Sources/\\n~/Summary.md\\r\\n\\n'");
        assert_eq!(complete(SH, &ok), ["~/Sources/", "~/Summary.md"]);
        let (_t2, bad) = agent_script("echo '~/x'; exit 1");
        assert_eq!(complete(SH, &bad), Vec::<String>::new());
        assert_eq!(complete("/no/such/program-zz", &[]), Vec::<String>::new());
    }
}
