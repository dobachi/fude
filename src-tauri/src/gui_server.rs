//! The GUI side of the `fude --wait` protocol (see `ipc.rs`).
//!
//! The running GUI listens on a local socket. Each connection is served by
//! its own thread: a reader thread turns incoming lines into events, and tab
//! closures reported by the frontend arrive on the same channel through the
//! [`WaitRegistry`]. The protocol logic itself lives in [`ConnState`], which
//! is plain data so it can be tested without sockets or Tauri.

use crate::ipc::{self, Message, PROTOCOL_VERSION};
use interprocess::local_socket::{prelude::*, ListenerOptions, Name};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, BufReader, Write};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

/// What the server asks the application to do. Implemented on the Tauri side
/// by emitting to the main window; tests use a recording stub.
pub trait OpenSink: Send + Sync + 'static {
    /// Open `path` (already absolute) in the GUI. `wait` tells the frontend
    /// to report when the tab closes.
    fn open(&self, path: &str, wait: bool) -> Result<(), String>;
}

/// Everything that can happen to one connection, in arrival order.
enum Event {
    Line(String),
    Eof,
    Closed { path: String, saved: bool },
}

/// Identifies a connection inside the registry so it can withdraw its own
/// waiters without touching other clients waiting on the same path.
type ConnId = u64;

/// Resolved path -> the connections waiting for its tab to close.
type Waiters = HashMap<String, Vec<(ConnId, Sender<Event>)>>;

/// Connections waiting for a tab to close, keyed by the resolved path.
#[derive(Default)]
pub struct WaitRegistry {
    waiters: Mutex<Waiters>,
    next_id: std::sync::atomic::AtomicU64,
}

impl WaitRegistry {
    fn new_conn_id(&self) -> ConnId {
        self.next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    fn register(&self, id: ConnId, path: &str, tx: Sender<Event>) {
        if let Ok(mut map) = self.waiters.lock() {
            map.entry(path.to_string()).or_default().push((id, tx));
        }
    }

    /// Called by the frontend when a tab closes. Returns how many waiters
    /// were notified (zero for tabs nobody asked about).
    pub fn tab_closed(&self, path: &str, saved: bool) -> usize {
        let txs = match self.waiters.lock() {
            Ok(mut map) => map.remove(path).unwrap_or_default(),
            Err(_) => return 0,
        };
        let mut n = 0;
        for (_, tx) in txs {
            if tx
                .send(Event::Closed {
                    path: path.to_string(),
                    saved,
                })
                .is_ok()
            {
                n += 1;
            }
        }
        n
    }

    /// Paths with at least one waiter.
    #[cfg(test)]
    fn waiting_paths(&self) -> Vec<String> {
        self.waiters
            .lock()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Withdraw every waiter connection `id` registered (the client left).
    fn forget(&self, id: ConnId, paths: &HashSet<String>) {
        if let Ok(mut map) = self.waiters.lock() {
            for p in paths {
                if let Some(v) = map.get_mut(p) {
                    v.retain(|(cid, _)| *cid != id);
                    if v.is_empty() {
                        map.remove(p);
                    }
                }
            }
        }
    }
}

/// Protocol state of one connection. `handle` consumes a message and yields
/// the replies to write; `closed` turns a tab closure into a reply.
#[derive(Debug, Default)]
pub struct ConnState {
    cwd: Option<String>,
    greeted: bool,
    /// Paths still to be reported `Closed`.
    pending: HashSet<String>,
    /// Set once an `Open` was processed; with `wait` the connection ends when
    /// `pending` drains, otherwise right after the replies are written.
    opened: bool,
    wait: bool,
}

impl ConnState {
    /// Paths this connection asked to wait for (for cleanup on disconnect).
    pub fn pending(&self) -> &HashSet<String> {
        &self.pending
    }

    /// True when nothing more will be sent and the connection can end.
    pub fn finished(&self) -> bool {
        self.opened && (!self.wait || self.pending.is_empty())
    }

    /// Process one message from the client. The second element lists the
    /// resolved paths the caller must register as waiters.
    pub fn handle(&mut self, msg: Message, sink: &dyn OpenSink) -> (Vec<Message>, Vec<String>) {
        match msg {
            Message::Hello { protocol, cwd, .. } => {
                if protocol != PROTOCOL_VERSION {
                    return (
                        vec![
                            Message::Error {
                                path: None,
                                message: format!(
                                    "protocol {} not supported (GUI speaks {})",
                                    protocol, PROTOCOL_VERSION
                                ),
                            },
                            Message::Bye,
                        ],
                        vec![],
                    );
                }
                self.greeted = true;
                self.cwd = cwd;
                (vec![], vec![])
            }
            Message::Open { paths, wait } => {
                if !self.greeted {
                    return (
                        vec![
                            Message::Error {
                                path: None,
                                message: "open before hello".into(),
                            },
                            Message::Bye,
                        ],
                        vec![],
                    );
                }
                self.opened = true;
                self.wait = wait;
                let base = self.cwd.as_ref().map(std::path::PathBuf::from);
                let mut replies = Vec::new();
                let mut register = Vec::new();
                for p in paths {
                    let resolved = crate::resolve_cli_path(&p, base.clone());
                    match sink.open(&resolved, wait) {
                        Ok(()) => {
                            replies.push(Message::Opened {
                                path: resolved.clone(),
                            });
                            if wait {
                                self.pending.insert(resolved.clone());
                                register.push(resolved);
                            }
                        }
                        Err(e) => replies.push(Message::Error {
                            path: Some(resolved),
                            message: e,
                        }),
                    }
                }
                if !wait {
                    replies.push(Message::Bye);
                }
                (replies, register)
            }
            Message::Bye => {
                // Client is leaving; stop waiting on its behalf.
                self.pending.clear();
                self.wait = false;
                self.opened = true;
                (vec![], vec![])
            }
            // Replies are never valid from a client.
            Message::Opened { .. } | Message::Closed { .. } | Message::Error { .. } => (
                vec![Message::Error {
                    path: None,
                    message: "unexpected message from client".into(),
                }],
                vec![],
            ),
        }
    }

    /// A tab closed. Returns the reply if this connection was waiting on it.
    pub fn closed(&mut self, path: &str, saved: bool) -> Option<Message> {
        if self.pending.remove(path) {
            Some(Message::Closed {
                path: path.to_string(),
                saved,
            })
        } else {
            None
        }
    }
}

/// Start listening on `name`. Returns once the socket is bound; connections
/// are served on background threads.
pub fn start(
    name: Name<'static>,
    registry: Arc<WaitRegistry>,
    sink: Arc<dyn OpenSink>,
) -> io::Result<()> {
    let listener = ListenerOptions::new()
        .name(name)
        .reclaim_name(true)
        .create_sync()?;
    thread::Builder::new()
        .name("fude-gui-ipc".into())
        .spawn(move || {
            for conn in listener.incoming() {
                match conn {
                    Ok(stream) => {
                        let registry = Arc::clone(&registry);
                        let sink = Arc::clone(&sink);
                        let _ = thread::Builder::new()
                            .name("fude-gui-ipc-conn".into())
                            .spawn(move || serve(stream, registry, sink));
                    }
                    Err(e) => eprintln!("fude: IPC accept failed: {}", e),
                }
            }
        })?;
    Ok(())
}

fn serve(
    stream: interprocess::local_socket::Stream,
    registry: Arc<WaitRegistry>,
    sink: Arc<dyn OpenSink>,
) {
    let (recv, mut send) = stream.split();
    let (tx, rx) = mpsc::channel::<Event>();

    let reader_tx = tx.clone();
    let _ = thread::Builder::new()
        .name("fude-gui-ipc-read".into())
        .spawn(move || {
            let mut reader = BufReader::new(recv);
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

    let conn_id = registry.new_conn_id();
    let mut state = ConnState::default();
    let write_all = |send: &mut dyn Write, msgs: &[Message]| -> bool {
        for m in msgs {
            if send.write_all(ipc::encode(m).as_bytes()).is_err() {
                return false;
            }
        }
        send.flush().is_ok()
    };

    while let Ok(ev) = rx.recv() {
        match ev {
            Event::Line(line) => {
                let replies = match ipc::decode(&line) {
                    Ok(None) => continue,
                    Ok(Some(msg)) => {
                        let (replies, register) = state.handle(msg, sink.as_ref());
                        for p in register {
                            registry.register(conn_id, &p, tx.clone());
                        }
                        replies
                    }
                    Err(e) => vec![Message::Error {
                        path: None,
                        message: e,
                    }],
                };
                let bye = replies.iter().any(|m| matches!(m, Message::Bye));
                if !write_all(&mut send, &replies) || bye || state.finished() {
                    break;
                }
            }
            Event::Closed { path, saved } => {
                if let Some(reply) = state.closed(&path, saved) {
                    if !write_all(&mut send, &[reply]) {
                        break;
                    }
                }
                if state.finished() {
                    let _ = write_all(&mut send, &[Message::Bye]);
                    break;
                }
            }
            Event::Eof => break,
        }
    }
    registry.forget(conn_id, state.pending());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Recorder {
        calls: Mutex<Vec<(String, bool)>>,
        fail_on: Option<String>,
    }

    impl OpenSink for Recorder {
        fn open(&self, path: &str, wait: bool) -> Result<(), String> {
            if self.fail_on.as_deref() == Some(path) {
                return Err("cannot open".into());
            }
            self.calls.lock().unwrap().push((path.to_string(), wait));
            Ok(())
        }
    }

    fn hello(cwd: &str) -> Message {
        Message::Hello {
            protocol: PROTOCOL_VERSION,
            cwd: Some(cwd.into()),
            cli_version: None,
        }
    }

    #[test]
    fn open_with_wait_registers_resolved_paths_and_waits_for_closed() {
        let sink = Recorder::default();
        let mut st = ConnState::default();
        assert_eq!(st.handle(hello("/work"), &sink).0, vec![]);

        let (replies, register) = st.handle(
            Message::Open {
                paths: vec!["notes.md".into(), "/abs/x.md".into()],
                wait: true,
            },
            &sink,
        );
        assert_eq!(register, vec!["/work/notes.md", "/abs/x.md"]);
        assert_eq!(
            replies,
            vec![
                Message::Opened {
                    path: "/work/notes.md".into()
                },
                Message::Opened {
                    path: "/abs/x.md".into()
                },
            ]
        );
        assert_eq!(
            *sink.calls.lock().unwrap(),
            vec![
                ("/work/notes.md".to_string(), true),
                ("/abs/x.md".to_string(), true)
            ]
        );
        assert!(!st.finished());

        assert_eq!(st.closed("/other.md", true), None);
        assert!(!st.finished());
        assert_eq!(
            st.closed("/abs/x.md", false),
            Some(Message::Closed {
                path: "/abs/x.md".into(),
                saved: false
            })
        );
        assert!(!st.finished());
        assert!(st.closed("/work/notes.md", true).is_some());
        assert!(st.finished());
    }

    #[test]
    fn open_without_wait_finishes_immediately_with_bye() {
        let sink = Recorder::default();
        let mut st = ConnState::default();
        st.handle(hello("/w"), &sink);
        let (replies, register) = st.handle(
            Message::Open {
                paths: vec!["a.md".into()],
                wait: false,
            },
            &sink,
        );
        assert!(register.is_empty());
        assert_eq!(replies.last(), Some(&Message::Bye));
        assert!(st.finished());
        assert_eq!(
            *sink.calls.lock().unwrap(),
            vec![("/w/a.md".to_string(), false)]
        );
    }

    #[test]
    fn a_path_the_gui_rejects_is_reported_and_not_waited_for() {
        let sink = Recorder {
            fail_on: Some("/w/bad.md".into()),
            ..Default::default()
        };
        let mut st = ConnState::default();
        st.handle(hello("/w"), &sink);
        let (replies, register) = st.handle(
            Message::Open {
                paths: vec!["bad.md".into(), "good.md".into()],
                wait: true,
            },
            &sink,
        );
        assert_eq!(register, vec!["/w/good.md"]);
        assert!(matches!(&replies[0], Message::Error { path: Some(p), .. } if p == "/w/bad.md"));
        assert!(matches!(&replies[1], Message::Opened { path } if path == "/w/good.md"));
    }

    #[test]
    fn open_before_hello_and_wrong_protocol_are_refused() {
        let sink = Recorder::default();
        let mut st = ConnState::default();
        let (replies, _) = st.handle(
            Message::Open {
                paths: vec!["a.md".into()],
                wait: true,
            },
            &sink,
        );
        assert!(matches!(replies[0], Message::Error { .. }));
        assert_eq!(replies[1], Message::Bye);
        assert!(sink.calls.lock().unwrap().is_empty());

        let (replies, _) = st.handle(
            Message::Hello {
                protocol: PROTOCOL_VERSION + 1,
                cwd: None,
                cli_version: None,
            },
            &sink,
        );
        assert!(
            matches!(&replies[0], Message::Error { message, .. } if message.contains("protocol"))
        );
        assert_eq!(replies[1], Message::Bye);
    }

    #[test]
    fn client_bye_stops_waiting() {
        let sink = Recorder::default();
        let mut st = ConnState::default();
        st.handle(hello("/w"), &sink);
        st.handle(
            Message::Open {
                paths: vec!["a.md".into()],
                wait: true,
            },
            &sink,
        );
        assert!(!st.finished());
        st.handle(Message::Bye, &sink);
        assert!(st.finished());
        assert!(st.pending().is_empty());
    }

    #[test]
    fn registry_notifies_every_waiter_once_and_then_forgets_the_path() {
        let reg = WaitRegistry::default();
        let (tx1, rx1) = mpsc::channel();
        let (tx2, rx2) = mpsc::channel();
        reg.register(reg.new_conn_id(), "/a.md", tx1);
        reg.register(reg.new_conn_id(), "/a.md", tx2);
        assert_eq!(reg.waiting_paths(), vec!["/a.md".to_string()]);
        assert_eq!(reg.tab_closed("/nobody.md", true), 0);
        assert_eq!(reg.tab_closed("/a.md", true), 2);
        assert!(
            matches!(rx1.recv().unwrap(), Event::Closed { ref path, saved: true } if path == "/a.md")
        );
        assert!(matches!(rx2.recv().unwrap(), Event::Closed { .. }));
        // Second closure of the same path has nobody left to tell.
        assert_eq!(reg.tab_closed("/a.md", true), 0);
        assert!(reg.waiting_paths().is_empty());
    }

    #[test]
    fn registry_drops_waiters_whose_connection_went_away() {
        let reg = WaitRegistry::default();
        let (tx, rx) = mpsc::channel();
        reg.register(reg.new_conn_id(), "/a.md", tx);
        drop(rx);
        assert_eq!(reg.tab_closed("/a.md", true), 0);
    }

    #[test]
    fn forget_withdraws_only_that_connections_waiters() {
        let reg = WaitRegistry::default();
        let (tx1, rx1) = mpsc::channel();
        let (tx2, rx2) = mpsc::channel();
        let c1 = reg.new_conn_id();
        let c2 = reg.new_conn_id();
        reg.register(c1, "/a.md", tx1);
        reg.register(c2, "/a.md", tx2);
        let mut gone = HashSet::new();
        gone.insert("/a.md".to_string());
        reg.forget(c1, &gone);
        assert_eq!(reg.tab_closed("/a.md", false), 1);
        assert!(rx1.try_recv().is_err());
        assert!(matches!(
            rx2.recv().unwrap(),
            Event::Closed { saved: false, .. }
        ));
    }
}
