//! `fude-cli`: Fude without a window.
//!
//! On a machine whose ssh session forwards a Fude GUI socket, `fude-cli
//! notes.md` opens the file in that GUI and serves it until the tab closes
//! (docs/TUI_DESIGN.md §4). The terminal UI (§5) is the fallback when no GUI
//! answers, and `--tui` opens it directly.

mod agent;
mod args;
mod bridge;
mod discover;
mod guis;
mod run;
mod setup;
mod tui;
mod watch;

use std::path::PathBuf;

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let mut args = match args::parse(&argv) {
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
        if args.check {
            std::process::exit(setup::check(host));
        }
        std::process::exit(setup::run(host, args.port, !args.no_share));
    }
    if let Some(host) = &args.remote {
        std::process::exit(setup::open_on(host, args.paths.first().map(String::as_str)));
    }
    if args.hosts {
        std::process::exit(setup::hosts());
    }
    if args.bridge {
        std::process::exit(bridge::run_bridge(args.exe.as_deref()));
    }
    if args.pipe {
        // The GUI on this (Windows) machine: its own pipe, then loopback TCP.
        let local = fude_core::config_dir()
            .map(|d| fude_core::ipc::socket_path(&d))
            .unwrap_or_else(|_| PathBuf::from("gui.sock"));
        let cands = [
            discover::Candidate::Socket(local),
            discover::Candidate::Tcp(discover::DEFAULT_TCP_ADDR.to_string()),
        ];
        std::process::exit(bridge::run_pipe(&cands));
    }
    let to = run::wanted_machine(args.to.as_deref());
    if args.check {
        match run::connect_all(&socket_candidates(), to.as_deref()) {
            Ok(all) => {
                for r in &all {
                    let version = r.conn.gui_version.as_deref().unwrap_or("?");
                    match &r.name {
                        Some(name) => {
                            println!("Fude {} on {} answers via {}", version, name, r.conn.via)
                        }
                        None => println!("Fude {} answers via {}", version, r.conn.via),
                    }
                }
                return;
            }
            Err(e) => {
                eprintln!("fude-cli: {}", e);
                std::process::exit(2);
            }
        }
    }
    if args.hex {
        let decoded: Result<Vec<String>, String> =
            args.paths.iter().map(|p| run::unhex(p)).collect();
        match decoded {
            Ok(paths) => args.paths = paths,
            Err(e) => {
                eprintln!("fude-cli: --hex: {}", e);
                std::process::exit(2);
            }
        }
    }
    if args.complete {
        if let Some(home) = dirs::home_dir() {
            let partial = args.paths.first().map(String::as_str).unwrap_or("");
            for c in run::completions(&home, partial) {
                println!("{}", c);
            }
        }
        return;
    }
    if args.here {
        let Some(home) = dirs::home_dir() else {
            eprintln!("fude-cli: cannot find the home directory");
            std::process::exit(2);
        };
        let wanted = args.paths.first().map(String::as_str).unwrap_or("~");
        let path = run::home_path(&home, wanted);
        if !path.exists() {
            eprintln!("fude-cli: {}: no such file or directory", path.display());
            std::process::exit(2);
        }
        args.paths = vec![path.to_string_lossy().to_string()];
        args.gui = true;
        if args.stdio {
            // The GUI started this process and speaks on its stdin/stdout:
            // serve there until it hangs up. Nothing else may be printed
            // on stdout.
            match run::connect_stdio() {
                Ok(conn) => std::process::exit(run::serve(conn, args.paths.clone(), false)),
                Err(e) => {
                    eprintln!("fude-cli: {}", e);
                    std::process::exit(2);
                }
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
    let conn = match run::connect(&candidates, to.as_deref()) {
        Ok(reached) => {
            // Say where the tab appears: with several machines set up, or a
            // Fude left open somewhere, "it opened" is not enough.
            if !args.foreground && reached.conn.via != discover::Candidate::Socket(local_socket()) {
                eprintln!("fude-cli: opened in {}", reached.describe());
            }
            reached.conn
        }
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
        let via = conn.via.clone();
        drop(conn);
        let log = run::log_path(&cache_dir());
        if let Err(e) = run::detach(&args, &log, &via) {
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

fn local_socket() -> PathBuf {
    fude_core::config_dir()
        .map(|d| fude_core::ipc::socket_path(&d))
        .unwrap_or_else(|_| PathBuf::from("gui.sock"))
}

fn socket_candidates() -> Vec<discover::Candidate> {
    let local = local_socket();
    let registered: Vec<u16> = fude_core::config_dir()
        .map(|d| guis::list(&guis::dir(&d)))
        .unwrap_or_default()
        .iter()
        .map(|g| g.port)
        .collect();
    discover::candidates(&discover::forward_dir(&cache_dir()), &local, &registered)
}
