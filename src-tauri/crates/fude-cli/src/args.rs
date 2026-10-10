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
    pub port: u16,
    /// `bridge`: relay this machine's GUI socket to the Fude on Windows.
    pub bridge: bool,
    /// `pipe`: the Windows half of `bridge` (internal).
    pub pipe: bool,
    /// `--exe PATH`: the Windows fude-cli.exe `bridge` should run.
    pub exe: Option<String>,
}

pub const USAGE: &str = "\
Usage: fude-cli [OPTIONS] [--] <PATH>...
       fude-cli setup <SSH-HOST> [--port N]
       fude-cli bridge [--exe PATH]
       fude-cli --check

Open files in the Fude GUI that your ssh session forwards to (see
docs/TUI_DESIGN.md §4.2), serving them to it until their tabs are closed.

Options:
  -w, --wait     Stay in the foreground until every tab is closed; exit 1 if
                 edits were discarded. Lets fude-cli serve as $EDITOR.
      --gui      Only use a forwarded GUI; fail if none answers
      --tui      Use the terminal UI (not implemented yet)
      --check    Report which GUI answers (and how), without opening anything
  -h, --help     Print help
  -V, --version  Print version

Commands:
  setup HOST     Prepare ssh host HOST: add the RemoteForward to ~/.ssh/config,
                 copy the GUI token and fude-cli there, verify the connection.
                 --port N uses a loopback port other than 47821.
  bridge         (WSL) Make the Fude running on Windows receive everything
                 opened from WSL — `fude-cli FILE` here and in ssh sessions
                 started from here — by relaying ~/.config/fude/gui.sock to
                 it. Needs no ssh from PowerShell and no firewall rule.

The GUI is found through $FUDE_GUI_SOCK, then ~/.cache/fude/gui/*.sock
(ssh RemoteForward targets), then the local ~/.config/fude/gui.sock.
";

/// Parse argv (argv[0] = executable). Unknown flags are an error so a typo
/// never silently becomes a file name.
pub fn parse(argv: &[String]) -> Result<Args, String> {
    let mut a = Args {
        port: crate::setup::DEFAULT_PORT,
        ..Default::default()
    };
    let mut operands_only = false;
    let mut want_port = false;
    let mut want_setup_host = argv.get(1).map(|s| s == "setup").unwrap_or(false);
    let mut want_exe = false;
    match argv.get(1).map(String::as_str) {
        Some("bridge") => a.bridge = true,
        Some("pipe") => a.pipe = true,
        _ => {}
    }
    let skip = if want_setup_host || a.bridge || a.pipe {
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
        if want_port {
            a.port = arg.parse().map_err(|_| format!("bad port '{}'", arg))?;
            want_port = false;
            continue;
        }
        if want_setup_host && !arg.starts_with('-') {
            a.setup = Some(arg.clone());
            want_setup_host = false;
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
    if argv.get(1).map(|s| s == "setup").unwrap_or(false) && a.setup.is_none() && !a.help {
        return Err("setup needs an ssh host".into());
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
        assert_eq!(a.port, 47821);
        let a = parse(&argv(&["fude-cli", "setup", "k16", "--port", "5000"])).unwrap();
        assert_eq!(a.port, 5000);
        assert!(parse(&argv(&["fude-cli", "setup"])).is_err());
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
