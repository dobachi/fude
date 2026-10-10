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
}

pub const USAGE: &str = "\
Usage: fude-cli [OPTIONS] [--] <PATH>...

Open files in the Fude GUI that your ssh session forwards to (see
docs/TUI_DESIGN.md §4.2), serving them to it until their tabs are closed.

Options:
  -w, --wait     Stay in the foreground until every tab is closed; exit 1 if
                 edits were discarded. Lets fude-cli serve as $EDITOR.
      --gui      Only use a forwarded GUI; fail if none answers
      --tui      Use the terminal UI (not implemented yet)
  -h, --help     Print help
  -V, --version  Print version

The GUI is found through $FUDE_GUI_SOCK, then ~/.cache/fude/gui/*.sock
(ssh RemoteForward targets), then the local ~/.config/fude/gui.sock.
";

/// Parse argv (argv[0] = executable). Unknown flags are an error so a typo
/// never silently becomes a file name.
pub fn parse(argv: &[String]) -> Result<Args, String> {
    let mut a = Args::default();
    let mut operands_only = false;
    for arg in argv.iter().skip(1) {
        if operands_only {
            a.paths.push(arg.clone());
            continue;
        }
        match arg.as_str() {
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
