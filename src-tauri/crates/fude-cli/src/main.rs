//! `fude-cli`: Fude without a window.
//!
//! On a machine whose ssh session forwards a Fude GUI socket, `fude-cli
//! notes.md` opens the file in that GUI and serves it until the tab closes
//! (docs/TUI_DESIGN.md §4). The terminal UI (§5) is the fallback when no GUI
//! answers, and `--tui` opens it directly.

mod agent;
mod args;
mod discover;
mod run;
mod setup;
mod tui;
mod watch;

use std::path::PathBuf;

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let args = match args::parse(&argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("fude-cli: {}\n\n{}", e, args::USAGE);
            std::process::exit(2);
        }
    };
    if args.help {
        print!("{}", args::USAGE);
        return;
    }
    if args.version {
        println!("fude-cli {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if let Some(host) = &args.setup {
        std::process::exit(setup::run(host, args.port));
    }
    if args.check {
        match run::connect(&socket_candidates()) {
            Ok(c) => {
                println!(
                    "Fude {} answers via {}",
                    c.gui_version.as_deref().unwrap_or("?"),
                    c.via
                );
                return;
            }
            Err(e) => {
                eprintln!("fude-cli: {}", e);
                std::process::exit(2);
            }
        }
    }
    if args.paths.is_empty() {
        eprintln!("fude-cli: nothing to open\n\n{}", args::USAGE);
        std::process::exit(2);
    }
    let paths = run::absolute_paths(&args.paths);
    if args.tui {
        std::process::exit(run_tui(&paths));
    }
    let candidates = socket_candidates();

    // The parent of a detached agent only checks that a GUI answers, so a
    // missing forward is reported on the terminal rather than in the log.
    let conn = match run::connect(&candidates) {
        Ok(c) => c,
        Err(e) => {
            // No GUI answers: fall back to the terminal UI (viewer for now),
            // unless that is pointless because there is no terminal either.
            use std::io::IsTerminal;
            if args.gui || !std::io::stdout().is_terminal() {
                eprintln!("fude-cli: {}", e);
                std::process::exit(2);
            }
            std::process::exit(run_tui(&paths));
        }
    };

    if !args.wait && !args.foreground {
        // Hand the socket back (the child opens its own) and return the shell.
        drop(conn);
        let log = run::log_path(&cache_dir());
        if let Err(e) = run::detach(&args, &log) {
            eprintln!("fude-cli: could not detach: {}", e);
            std::process::exit(2);
        }
        return;
    }

    // A detached agent logs what it serves; `--wait` stays quiet for $EDITOR.
    std::process::exit(run::serve(conn, paths, args.foreground));
}

/// The terminal UI: files open as tabs, a directory as the file list.
fn run_tui(paths: &[String]) -> i32 {
    tui::run(paths)
}

fn cache_dir() -> PathBuf {
    dirs::cache_dir().unwrap_or_else(std::env::temp_dir)
}

fn socket_candidates() -> Vec<discover::Candidate> {
    let local = fude_core::config_dir()
        .map(|d| fude_core::ipc::socket_path(&d))
        .unwrap_or_else(|_| PathBuf::from("gui.sock"));
    discover::candidates(&discover::forward_dir(&cache_dir()), &local)
}
