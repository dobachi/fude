//! `fude-cli [OPTIONS] [--] <PATH>...`

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Args {
    pub paths: Vec<String>,
    /// Stay in the foreground until every tab is closed (`$EDITOR` use).
    pub wait: bool,
    /// Force the GUI route (fail instead of falling back).
    pub gui: bool,
    /// Force the terminal UI.
    pub tui: bool,
    /// Internal: this process is the detached child that serves files.
    pub foreground: bool,
    pub help: bool,
    pub version: bool,
    /// `--check`: connect to the GUI, report its version, open nothing.
    pub check: bool,
    /// `setup <ssh-host>`: configure a remote machine (see setup.rs).
    pub setup: Option<String>,
    pub port: Option<u16>,
    /// `remote <ssh-host> [PATH]`: open PATH on that host in this machine's
    /// Fude (the path is the one operand in `paths`).
    pub remote: Option<String>,
    /// `here [PATH]`: open PATH on this machine, read from the home
    /// directory (for callers without a shell or a working directory).
    pub here: bool,
    /// `hosts`: list the ssh hosts this machine knows.
    pub hosts: bool,
    /// `--to NAME`: the machine whose Fude gets the files, when several do.
    pub to: Option<String>,
    /// `bridge`: relay this machine's GUI socket to the Fude on Windows.
    pub bridge: bool,
    /// `pipe`: the Windows half of `bridge` (internal).
    pub pipe: bool,
    /// `--exe PATH`: the Windows fude-cli.exe `bridge` should run.
    pub exe: Option<String>,
    /// `setup --no-share`: do not add ssh connection sharing for the host.
    pub no_share: bool,
}

pub const USAGE: &str = "\
Usage: fude-cli [OPTIONS] [--] <PATH>...
       fude-cli setup <SSH-HOST> [--port N] [--no-share] [--check]
       fude-cli bridge [--exe PATH]
       fude-cli --check

Open files in the Fude GUI this machine can reach — the one your ssh session
forwards to, a `fude bridge`, or a local Fude — and serve them to it until
their tabs are closed. Without a reachable GUI, edit in the terminal instead.
Guide: docs/REMOTE.md

Options:
  -w, --wait     Stay in the foreground until every tab is closed; exit 1 if
                 edits were discarded. Lets fude-cli serve as $EDITOR.
      --gui      Only use a GUI; fail if none answers
      --tui      Edit in the terminal: tabs, file list (pass a directory),
                 live preview. Ctrl+S saves, Alt+Q quits, F1 lists the keys.
      --to NAME  Open on the machine NAME, when Fude answers on several
                 (they are listed, and asked about, without it; $FUDE_TO
                 sets it for a whole session)
      --check    Report which GUI answers (and how), without opening anything
  -h, --help     Print help
  -V, --version  Print version

Commands:
  setup HOST     Prepare ssh host HOST: add the RemoteForward to ~/.ssh/config,
                 copy the GUI token and fude-cli there, verify the connection.
                 Each machine gets a loopback port of its own on HOST, so
                 several can use HOST at once (--port N picks it). Also turns
                 on ssh connection sharing for HOST, so that every session
                 to it reaches Fude, not just the first (--no-share skips).
                 --check changes nothing: it only asks HOST which Fude its
                 fude-cli reaches.
  remote HOST [PATH]
                 Open PATH on ssh host HOST (default: the home directory
                 there) in this machine's Fude, without logging in first.
                 HOST must have been set up.
  here [PATH]    Open PATH on this machine in the Fude that answers, with
                 `~` and relative paths read from the home directory and no
                 terminal fallback (what the app runs inside WSL).
  hosts          List the ssh hosts in ~/.ssh/config, one per line.
  bridge         (WSL) Make the Fude running on Windows receive everything
                 opened from WSL — `fude-cli FILE` here and in ssh sessions
                 started from here — by relaying ~/.config/fude/gui.sock to
                 it. Needs no ssh from PowerShell and no firewall rule.

The GUI is found through $FUDE_GUI_SOCK, $FUDE_GUI_ADDR, ~/.cache/fude/gui/*.sock,
the loopback ports `setup` makes ssh forward, then ~/.config/fude/gui.sock.
Remote agents present the token `fude setup` left in ~/.config/fude/guis/
(or ~/.config/fude/gui-token; $FUDE_GUI_TOKEN overrides both).
";

/// Parse argv (argv[0] = executable). Unknown flags are an error so a typo
/// never silently becomes a file name.
pub fn parse(argv: &[String]) -> Result<Args, String> {
    let mut a = Args {
        port: None,
        ..Default::default()
    };
    let mut operands_only = false;
    let mut want_port = false;
    let mut want_setup_host = argv.get(1).map(|s| s == "setup").unwrap_or(false);
    let mut want_remote_host = argv.get(1).map(|s| s == "remote").unwrap_or(false);
    let mut want_exe = false;
    let mut want_to = false;
    match argv.get(1).map(String::as_str) {
        Some("bridge") => a.bridge = true,
        Some("pipe") => a.pipe = true,
        Some("hosts") => a.hosts = true,
        Some("here") => a.here = true,
        _ => {}
    }
    let skip = if want_setup_host || want_remote_host || a.bridge || a.pipe || a.hosts || a.here {
        2
    } else {
        1
    };
    for arg in argv.iter().skip(skip) {
        if want_exe {
            a.exe = Some(arg.clone());
            want_exe = false;
            continue;
        }
        if want_to {
            a.to = Some(arg.clone());
            want_to = false;
            continue;
        }
        if want_port {
            a.port = Some(arg.parse().map_err(|_| format!("bad port '{}'", arg))?);
            want_port = false;
            continue;
        }
        if want_setup_host && !arg.starts_with('-') {
            a.setup = Some(arg.clone());
            want_setup_host = false;
            continue;
        }
        if want_remote_host && !arg.starts_with('-') {
            a.remote = Some(arg.clone());
            want_remote_host = false;
            continue;
        }
        if operands_only {
            a.paths.push(arg.clone());
            continue;
        }
        match arg.as_str() {
            "--check" => a.check = true,
            "--port" => want_port = true,
            "--exe" => want_exe = true,
            "--to" => want_to = true,
            s if s.starts_with("--to=") => a.to = Some(s["--to=".len()..].to_string()),
            "--no-share" => a.no_share = true,
            "--" => operands_only = true,
            "-w" | "--wait" => a.wait = true,
            "--gui" => a.gui = true,
            "--tui" => a.tui = true,
            "--_foreground" => a.foreground = true,
            "-h" | "--help" => a.help = true,
            "-V" | "--version" => a.version = true,
            s if s.starts_with('-') && s.len() > 1 => {
                return Err(format!("unknown option '{}'", s));
            }
            _ => a.paths.push(arg.clone()),
        }
    }
    if a.gui && a.tui {
        return Err("--gui and --tui are mutually exclusive".into());
    }
    if want_port {
        return Err("--port needs a value".into());
    }
    if want_exe {
        return Err("--exe needs a value".into());
    }
    if want_to || a.to.as_deref().is_some_and(|t| t.trim().is_empty()) {
        return Err("--to needs a machine name".into());
    }
    if argv.get(1).map(|s| s == "setup").unwrap_or(false) && a.setup.is_none() && !a.help {
        return Err("setup needs an ssh host".into());
    }
    if argv.get(1).map(|s| s == "remote").unwrap_or(false) && !a.help {
        if a.remote.is_none() {
            return Err("remote needs an ssh host".into());
        }
        if a.paths.len() > 1 {
            return Err("remote opens one path at a time".into());
        }
    }
    Ok(a)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn collects_paths_and_flags() {
        let a = parse(&argv(&["fude-cli", "-w", "a.md", "--gui", "b.md"])).unwrap();
        assert_eq!(a.paths, vec!["a.md", "b.md"]);
        assert!(a.wait && a.gui && !a.tui && !a.foreground);
    }

    #[test]
    fn double_dash_ends_options_and_lone_dash_is_a_path() {
        let a = parse(&argv(&["fude-cli", "--", "--weird.md", "-"])).unwrap();
        assert_eq!(a.paths, vec!["--weird.md", "-"]);
        let a = parse(&argv(&["fude-cli", "-"])).unwrap();
        assert_eq!(a.paths, vec!["-"]);
    }

    #[test]
    fn rejects_unknown_and_conflicting_options() {
        assert!(parse(&argv(&["fude-cli", "--wat"])).is_err());
        assert!(parse(&argv(&["fude-cli", "--gui", "--tui"])).is_err());
    }

    #[test]
    fn setup_takes_a_host_and_an_optional_port() {
        let a = parse(&argv(&["fude-cli", "setup", "k16"])).unwrap();
        assert_eq!(a.setup.as_deref(), Some("k16"));
        assert_eq!(a.port, None);
        let a = parse(&argv(&["fude-cli", "setup", "k16", "--port", "5000"])).unwrap();
        assert_eq!(a.port, Some(5000));
        let a = parse(&argv(&["fude-cli", "remote", "k16", "--", "~/notes"])).unwrap();
        assert_eq!(a.remote.as_deref(), Some("k16"));
        assert_eq!(a.paths, ["~/notes"]);
        let a = parse(&argv(&["fude-cli", "remote", "k16"])).unwrap();
        assert!(a.paths.is_empty());
        assert!(parse(&argv(&["fude-cli", "remote"])).is_err());
        assert!(parse(&argv(&["fude-cli", "remote", "k16", "a", "b"])).is_err());
        assert!(parse(&argv(&["fude-cli", "hosts"])).unwrap().hosts);
        let a = parse(&argv(&["fude-cli", "here", "--", "~/notes"])).unwrap();
        assert!(a.here);
        assert_eq!(a.paths, ["~/notes"]);
        assert!(parse(&argv(&["fude-cli", "here"]))
            .unwrap()
            .paths
            .is_empty());
        // A file that happens to be called `hosts` is still openable.
        let a = parse(&argv(&["fude-cli", "./hosts"])).unwrap();
        assert!(!a.hosts);
        assert_eq!(a.paths, ["./hosts"]);
        let a = parse(&argv(&["fude-cli", "--to", "gpdmd", "x.md"])).unwrap();
        assert_eq!(a.to.as_deref(), Some("gpdmd"));
        assert_eq!(a.paths, ["x.md"]);
        let a = parse(&argv(&["fude-cli", "--to=home-wsl", "x.md"])).unwrap();
        assert_eq!(a.to.as_deref(), Some("home-wsl"));
        assert!(parse(&argv(&["fude-cli", "x.md", "--to"])).is_err());
        assert!(parse(&argv(&["fude-cli", "--to=", "x.md"])).is_err());
        assert!(parse(&argv(&["fude-cli", "setup"])).is_err());
        assert!(!a.no_share);
        assert!(
            parse(&argv(&["fude-cli", "setup", "k16", "--no-share"]))
                .unwrap()
                .no_share
        );
        let a = parse(&argv(&["fude-cli", "setup", "k16", "--check"])).unwrap();
        assert_eq!(a.setup.as_deref(), Some("k16"));
        assert!(a.check);
        assert!(parse(&argv(&["fude-cli", "setup", "k16", "--port"])).is_err());
        assert!(parse(&argv(&["fude-cli", "setup", "k16", "--port", "x"])).is_err());
        // A file literally named "setup" is still a path when not first.
        let a = parse(&argv(&["fude-cli", "-w", "setup"])).unwrap();
        assert_eq!(a.paths, vec!["setup"]);
        assert!(parse(&argv(&["fude-cli", "--check"])).unwrap().check);
    }

    #[test]
    fn bridge_and_pipe_are_first_argument_subcommands() {
        let a = parse(&argv(&["fude-cli", "bridge", "--exe", "/x/fude-cli.exe"])).unwrap();
        assert!(a.bridge && !a.pipe);
        assert_eq!(a.exe.as_deref(), Some("/x/fude-cli.exe"));
        assert!(parse(&argv(&["fude-cli", "pipe"])).unwrap().pipe);
        assert!(parse(&argv(&["fude-cli", "bridge", "--exe"])).is_err());
        // Not first: an ordinary file name.
        let a = parse(&argv(&["fude-cli", "-w", "bridge"])).unwrap();
        assert!(!a.bridge);
        assert_eq!(a.paths, vec!["bridge"]);
    }

    #[test]
    fn help_and_version_are_flags_too() {
        assert!(parse(&argv(&["fude-cli", "-h"])).unwrap().help);
        assert!(parse(&argv(&["fude-cli", "--version"])).unwrap().version);
        assert!(
            parse(&argv(&["fude-cli", "--_foreground", "x"]))
                .unwrap()
                .foreground
        );
    }
}
