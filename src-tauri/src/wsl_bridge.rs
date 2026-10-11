//! Windows: run the WSL half of `fude bridge` from the app (optional).
//!
//! `fude-cli bridge` has to run inside WSL for the Fude on Windows to receive
//! what is opened there (and in ssh sessions started there). Rather than have
//! the user install Fude in WSL and start the bridge by hand after every WSL
//! restart, the app can do it: put the Linux `fude-cli` of its own version
//! into the chosen distro and keep `bridge` running there as a child for as
//! long as the app lives.
//!
//! Everything goes to `wsl.exe -d DISTRO -e sh -s` as a script on stdin, with
//! the values written into the script. Nothing but the distro name travels on
//! the command line, so wsl.exe's own quoting rules never see a path.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

pub const RELEASE_BASE: &str = "https://github.com/dobachi/fude/releases/download";

/// How many lines of the bridge's output are kept for the settings panel.
const LOG_LINES: usize = 40;

/// Run inside the distro with `$1` = version, `$2` = release base URL,
/// `$3` = Windows path of the bundled fude-cli.exe.
///
/// A bridge left over from an app that did not exit cleanly still holds the
/// socket, so the previous one (recorded by pid) is stopped first.
const BRIDGE_BODY: &str = r#"set -e
d="$HOME/.cache/fude"
b="$d/fude-cli-$1"
mkdir -p "$d"
if [ ! -x "$b" ]; then
  echo "fude: downloading fude-cli $1 into WSL" >&2
  curl -fsSL -o "$b.tmp" "$2/v$1/fude-cli-linux-$(uname -m)"
  chmod 755 "$b.tmp"
  mv "$b.tmp" "$b"
fi
l="$HOME/.local/bin/fude-cli"
if [ -L "$l" ] || ! command -v fude-cli >/dev/null 2>&1; then
  mkdir -p "$HOME/.local/bin"
  ln -sf "$b" "$l"
fi
p="$d/bridge.pid"
if [ -r "$p" ]; then
  old=$(cat "$p")
  if [ -n "$old" ] && grep -qa bridge "/proc/$old/cmdline" 2>/dev/null; then
    kill "$old" 2>/dev/null || true
    sleep 1
  fi
fi
echo $$ > "$p"
exec "$b" bridge --exe "$(wslpath -u "$3")"
"#;

/// Run inside the distro with `$1` = version, the rest = fude-cli arguments.
const CLI_BODY: &str = r#"b="$HOME/.cache/fude/fude-cli-$1"
shift
if [ ! -x "$b" ]; then
  echo "fude-cli is not in this WSL distro yet: turn WSL integration on first" >&2
  exit 2
fi
exec "$b" "$@"
"#;

/// `s` as one single-quoted sh word.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn script(args: &[&str], body: &str) -> String {
    let words: Vec<String> = args.iter().map(|a| sh_quote(a)).collect();
    format!("set -- {}\n{}", words.join(" "), body)
}

/// `\\?\C:\…` (what `canonicalize` yields on Windows) as plain `C:\…`.
pub fn plain_windows_path(p: &str) -> &str {
    p.strip_prefix(r"\\?\").unwrap_or(p)
}

/// The script that installs fude-cli in the distro and runs the bridge.
pub fn bridge_script(version: &str, release_base: &str, exe_win: &str) -> String {
    script(
        &[version, release_base, plain_windows_path(exe_win)],
        BRIDGE_BODY,
    )
}

/// The script that runs the distro's fude-cli with `cli_args`.
pub fn cli_script(version: &str, cli_args: &[String]) -> String {
    let mut all = vec![version];
    all.extend(cli_args.iter().map(String::as_str));
    script(&all, CLI_BODY)
}

/// A distro name as `wsl.exe -l -q` prints it. It is the one value that goes
/// on wsl.exe's command line, so it is held to what such names consist of.
pub fn valid_distro(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty()
        || n.len() > 64
        || n.starts_with('-')
        || !n
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err(format!(
            "WSL のディストリビューション名として使えません: {}",
            n
        ));
    }
    Ok(n.to_string())
}

/// `wsl.exe` arguments that run a script from stdin in `distro`.
pub fn wsl_args(distro: &str) -> Vec<String> {
    ["-d", distro, "-e", "sh", "-s"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// The distro names in `wsl.exe -l -q` output, which is UTF-16LE unless
/// `WSL_UTF8=1` is set.
pub fn parse_distros(raw: &[u8]) -> Vec<String> {
    let looks_utf16 = raw.len() >= 2
        && raw.len().is_multiple_of(2)
        && raw.iter().skip(1).step_by(2).any(|b| *b == 0);
    let text = if looks_utf16 {
        let units: Vec<u16> = raw
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(raw).to_string()
    };
    text.lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}' || c == '\0'))
        .filter(|l| !l.is_empty())
        .filter(|l| valid_distro(l).is_ok())
        .map(str::to_string)
        .collect()
}

/// Keep Windows from flashing a console window for a child process.
pub fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Run `program args…` feeding it `script` on stdin and wait for it.
/// Returns (success, stdout, stderr).
pub fn run_script(
    program: &str,
    args: &[String],
    script: &str,
) -> Result<(bool, Vec<u8>, Vec<u8>), String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{} を実行できません: {}", program, e))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(script.as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok((out.status.success(), out.stdout, out.stderr))
}

type Log = Arc<Mutex<VecDeque<String>>>;

fn collect(from: impl Read + Send + 'static, log: Log) {
    std::thread::spawn(move || {
        for line in BufReader::new(from).lines() {
            let Ok(line) = line else { break };
            let line = line.trim_end().to_string();
            if line.is_empty() {
                continue;
            }
            if let Ok(mut l) = log.lock() {
                if l.len() == LOG_LINES {
                    l.pop_front();
                }
                l.push_back(line);
            }
        }
    });
}

#[derive(Default)]
struct Running {
    child: Option<Child>,
    distro: Option<String>,
    log: Log,
}

/// The bridge child, if any. One per app.
#[derive(Default)]
pub struct Manager {
    state: Mutex<Running>,
}

impl Manager {
    /// Start `program args…` with `script` on stdin as the bridge for
    /// `distro`, replacing a bridge that is already running.
    pub fn start(
        &self,
        program: &str,
        args: &[String],
        script: &str,
        distro: &str,
    ) -> Result<(), String> {
        let mut st = self.state.lock().map_err(|e| e.to_string())?;
        stop_child(&mut st);
        let mut cmd = Command::new(program);
        cmd.args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        no_window(&mut cmd);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("{} を実行できません: {}", program, e))?;
        if let Some(mut stdin) = child.stdin.take() {
            // Dropped right after: the script ends in `exec`, and the bridge
            // reads nothing from stdin.
            let _ = stdin.write_all(script.as_bytes());
        }
        let log: Log = Arc::default();
        if let Some(out) = child.stdout.take() {
            collect(out, Arc::clone(&log));
        }
        if let Some(err) = child.stderr.take() {
            collect(err, Arc::clone(&log));
        }
        st.child = Some(child);
        st.distro = Some(distro.to_string());
        st.log = log;
        Ok(())
    }

    /// Stop the bridge. Ending wsl.exe ends the process it runs in WSL.
    pub fn stop(&self) {
        if let Ok(mut st) = self.state.lock() {
            stop_child(&mut st);
            st.distro = None;
        }
    }

    /// (distro it was started for, still running, what it printed last).
    pub fn status(&self) -> (Option<String>, bool, String) {
        let Ok(mut st) = self.state.lock() else {
            return (None, false, String::new());
        };
        let running = match st.child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        };
        let log = st
            .log
            .lock()
            .map(|l| l.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default();
        (st.distro.clone(), running, log)
    }
}

fn stop_child(st: &mut Running) {
    if let Some(mut c) = st.child.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

impl Drop for Manager {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    fn wait_for(mut cond: impl FnMut() -> bool) -> bool {
        let end = Instant::now() + Duration::from_secs(10);
        while Instant::now() < end {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn values_are_quoted_into_the_script_not_the_command_line() {
        assert_eq!(sh_quote("a b"), "'a b'");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(sh_quote("$(x)`y`"), "'$(x)`y`'");
        let sc = bridge_script(
            "0.8.6",
            "https://e/x",
            r"\\?\C:\Program Files\Fude\fude-cli.exe",
        );
        assert!(sc.starts_with(
            "set -- '0.8.6' 'https://e/x' 'C:\\Program Files\\Fude\\fude-cli.exe'\nset -e\n"
        ));
        assert_eq!(plain_windows_path(r"C:\x"), r"C:\x");
        assert_eq!(
            wsl_args("Ubuntu-22.04"),
            s(&["-d", "Ubuntu-22.04", "-e", "sh", "-s"])
        );
        let sc = cli_script("0.8.6", &s(&["setup", "me@k16", "--check"]));
        assert!(sc.starts_with("set -- '0.8.6' 'setup' 'me@k16' '--check'\n"));
    }

    #[test]
    fn distro_names_are_plain_words() {
        assert_eq!(
            valid_distro(" Ubuntu-22.04-k "),
            Ok("Ubuntu-22.04-k".into())
        );
        assert!(valid_distro("docker-desktop").is_ok());
        for bad in ["", "  ", "-d", "a b", "a;b", "a\"b", "a'b", "$(x)", "名前"] {
            assert!(valid_distro(bad).is_err(), "{:?}", bad);
        }
        assert!(valid_distro(&"a".repeat(65)).is_err());
    }

    #[test]
    fn distro_lists_are_read_in_either_encoding() {
        let utf16: Vec<u8> = "CentOS7\r\ndocker-desktop\r\nUbuntu-22.04-k\r\n"
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        let want = s(&["CentOS7", "docker-desktop", "Ubuntu-22.04-k"]);
        assert_eq!(parse_distros(&utf16), want);
        assert_eq!(
            parse_distros(b"CentOS7\ndocker-desktop\nUbuntu-22.04-k\n"),
            want
        );
        let mut bom = vec![0xff, 0xfe];
        bom.extend(&utf16);
        assert_eq!(parse_distros(&bom), want);
        assert_eq!(parse_distros(b""), Vec::<String>::new());
        // An error message instead of a list yields no distros.
        assert_eq!(
            parse_distros(b"Windows Subsystem for Linux has no installed distributions.\n"),
            Vec::<String>::new()
        );
    }

    /// The real script, in a real sh, with a fake HOME and stand-ins for the
    /// three commands it needs from its surroundings.
    #[cfg(unix)]
    fn run_bridge_script(home: &std::path::Path, bin: &std::path::Path) -> (bool, String, String) {
        let sc = bridge_script(
            "9.9.9",
            "https://rel.example/dl",
            r"C:\Program Files\Fude\fude-cli.exe",
        );
        // PATH holds only `bin`, so whether this machine happens to have a
        // fude-cli installed cannot change what the script decides.
        for tool in [
            "mkdir", "chmod", "mv", "cat", "grep", "ln", "uname", "sleep", "kill",
        ] {
            let link = bin.join(tool);
            if link.exists() {
                continue;
            }
            let real = ["/usr/bin", "/bin"]
                .iter()
                .map(|d| std::path::Path::new(d).join(tool))
                .find(|p| p.exists());
            if let Some(real) = real {
                std::os::unix::fs::symlink(real, link).unwrap();
            }
        }
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-s")
            .env("HOME", home)
            .env("PATH", bin)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(sc.as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).to_string(),
            String::from_utf8_lossy(&out.stderr).to_string(),
        )
    }

    #[cfg(unix)]
    fn write_exe(path: &std::path::Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, body).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_bridge_script_installs_once_then_runs_the_bridge() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path().join("home");
        let bin = tmp.path().join("bin");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        // curl: record the URL, "download" a fude-cli that prints its args.
        write_exe(
            &bin.join("curl"),
            &format!(
                "#!/bin/sh\necho \"$@\" >> '{}'\nwhile [ $# -gt 1 ]; do [ \"$1\" = -o ] && out=\"$2\"; shift; done\nprintf '#!/bin/sh\\nprintf \"RUN %%s\\\\n\" \"$*\"\\n' > \"$out\"\n",
                tmp.path().join("curl.log").display()
            ),
        );
        write_exe(
            &bin.join("wslpath"),
            "#!/bin/sh\nprintf '/mnt/c/converted:%s\\n' \"$2\"\n",
        );

        let (ok, out, err) = run_bridge_script(&home, &bin);
        assert!(ok, "{}", err);
        assert_eq!(
            out.trim(),
            r"RUN bridge --exe /mnt/c/converted:C:\Program Files\Fude\fude-cli.exe"
        );
        assert!(err.contains("downloading fude-cli 9.9.9"));
        let arch =
            String::from_utf8_lossy(&Command::new("uname").arg("-m").output().unwrap().stdout)
                .trim()
                .to_string();
        let curl_log = std::fs::read_to_string(tmp.path().join("curl.log")).unwrap();
        assert!(curl_log.contains(&format!(
            "https://rel.example/dl/v9.9.9/fude-cli-linux-{}",
            arch
        )));
        assert!(home.join(".cache/fude/fude-cli-9.9.9").is_file());
        // `fude-cli` becomes typable in the distro, and a pid is recorded.
        assert_eq!(
            std::fs::read_link(home.join(".local/bin/fude-cli")).unwrap(),
            home.join(".cache/fude/fude-cli-9.9.9")
        );
        assert!(home.join(".cache/fude/bridge.pid").is_file());

        // Second start: nothing is downloaded again.
        let (ok, out, err) = run_bridge_script(&home, &bin);
        assert!(ok, "{}", err);
        assert!(out.contains("RUN bridge --exe"));
        assert!(!err.contains("downloading"));
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("curl.log"))
                .unwrap()
                .lines()
                .count(),
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_installed_fude_cli_is_not_shadowed_but_our_own_link_is_refreshed() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path().join("home");
        let bin = tmp.path().join("bin");
        std::fs::create_dir_all(home.join(".cache/fude")).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        write_exe(&home.join(".cache/fude/fude-cli-9.9.9"), "#!/bin/sh\n");
        write_exe(&bin.join("curl"), "#!/bin/sh\nexit 1\n");
        write_exe(&bin.join("wslpath"), "#!/bin/sh\nprintf x\n");
        // Someone else's fude-cli on PATH (a package, say): leave it be.
        write_exe(&bin.join("fude-cli"), "#!/bin/sh\n");
        let (ok, _, err) = run_bridge_script(&home, &bin);
        assert!(ok, "{}", err);
        assert!(!home.join(".local/bin/fude-cli").exists());

        // A link from an earlier version of ours follows the new version.
        std::fs::create_dir_all(home.join(".local/bin")).unwrap();
        std::os::unix::fs::symlink(
            home.join(".cache/fude/fude-cli-1.0.0"),
            home.join(".local/bin/fude-cli"),
        )
        .unwrap();
        let (ok, _, err) = run_bridge_script(&home, &bin);
        assert!(ok, "{}", err);
        assert_eq!(
            std::fs::read_link(home.join(".local/bin/fude-cli")).unwrap(),
            home.join(".cache/fude/fude-cli-9.9.9")
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_download_stops_the_script_and_leaves_nothing_runnable() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path().join("home");
        let bin = tmp.path().join("bin");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        write_exe(
            &bin.join("curl"),
            "#!/bin/sh\necho 'curl: (22) 404' >&2\nexit 22\n",
        );
        write_exe(&bin.join("wslpath"), "#!/bin/sh\necho x\n");
        let (ok, out, err) = run_bridge_script(&home, &bin);
        assert!(!ok);
        assert!(out.is_empty());
        assert!(err.contains("404"));
        assert!(!home.join(".cache/fude/fude-cli-9.9.9").exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_cli_script_runs_the_installed_cli_or_says_what_is_missing() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(home.join(".cache/fude")).unwrap();
        let sc = cli_script("9.9.9", &s(&["setup", "it's k16", "--check"]));
        let run = |home: &std::path::Path| {
            let mut child = Command::new("sh")
                .arg("-s")
                .env("HOME", home)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(sc.as_bytes())
                .unwrap();
            child.wait_with_output().unwrap()
        };
        let out = run(&home);
        assert_eq!(out.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&out.stderr).contains("turn WSL integration on"));

        write_exe(
            &home.join(".cache/fude/fude-cli-9.9.9"),
            "#!/bin/sh\nfor a in \"$@\"; do echo \"[$a]\"; done\n",
        );
        let out = run(&home);
        assert!(out.status.success());
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            "[setup]\n[it's k16]\n[--check]\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_manager_runs_reports_and_stops_one_bridge() {
        let m = Manager::default();
        assert_eq!(m.status(), (None, false, String::new()));

        m.start(
            "sh",
            &s(&["-s"]),
            "echo up >&2\nexec sleep 600\n",
            "distro-a",
        )
        .unwrap();
        assert!(wait_for(|| m.status().2 == "up"));
        let (distro, running, _) = m.status();
        assert_eq!(distro.as_deref(), Some("distro-a"));
        assert!(running);

        // Starting again replaces the first one.
        m.start(
            "sh",
            &s(&["-s"]),
            "echo second\nexec sleep 600\n",
            "distro-b",
        )
        .unwrap();
        assert!(wait_for(|| m.status().2 == "second"));
        assert_eq!(m.status().0.as_deref(), Some("distro-b"));

        m.stop();
        assert_eq!(m.status().0, None);
        assert!(!m.status().1);
    }

    #[cfg(unix)]
    #[test]
    fn a_bridge_that_exits_is_reported_with_its_last_words() {
        let m = Manager::default();
        m.start(
            "sh",
            &s(&["-s"]),
            "echo 'gui.sock is in use' >&2\nexit 2\n",
            "d",
        )
        .unwrap();
        assert!(wait_for(|| !m.status().1 && m.status().2.contains("in use")));
        assert_eq!(m.status().0.as_deref(), Some("d"));
        assert!(m
            .start("/nonexistent/wsl.exe", &[], "", "d")
            .unwrap_err()
            .contains("実行できません"));
    }

    #[cfg(unix)]
    #[test]
    fn run_script_returns_status_and_both_streams() {
        let (ok, out, err) = run_script("sh", &s(&["-s"]), "echo o\necho e >&2\n").unwrap();
        assert!(ok);
        assert_eq!((out.as_slice(), err.as_slice()), (&b"o\n"[..], &b"e\n"[..]));
        let (ok, _, _) = run_script("sh", &s(&["-s"]), "exit 3\n").unwrap();
        assert!(!ok);
        assert!(run_script("/nonexistent/wsl.exe", &[], "").is_err());
    }
}
