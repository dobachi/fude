//! The GUI side of the IPC protocol (see `fude_core::ipc`).
//!
//! The running GUI listens on a local socket. Each connection is served by
//! its own thread: a reader thread turns incoming lines into events, tab
//! closures reported by the frontend arrive on the same channel through the
//! [`WaitRegistry`], and requests the frontend wants sent to a remote agent
//! arrive through [`RemoteSessions`]. The protocol logic itself lives in
//! [`ConnState`], which is plain data so it can be tested without sockets
//! or Tauri.

use fude_core::ipc::{self, remote_path, Message, PROTOCOL_VERSION};
use interprocess::local_socket::{prelude::*, ListenerOptions, Name};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, BufReader, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// How long a frontend request to a remote agent may take.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// What the server asks the application to do. Implemented on the Tauri side
/// by emitting to the main window; tests use a recording stub.
pub trait OpenSink: Send + Sync + 'static {
    /// Open `path` (absolute, or `remote://host/...`) in the GUI. `wait`
    /// tells the frontend to report when the tab closes.
    fn open(&self, path: &str, wait: bool) -> Result<(), String>;
    /// A remote agent reports `path` (already `remote://...`) changed on disk.
    fn file_changed(&self, _path: &str) {}
    /// The agent for `host` went away.
    fn disconnected(&self, _host: &str) {}
}

/// Everything that can happen to one connection, in arrival order.
enum Event {
    Line(String),
    Eof,
    Closed {
        path: String,
        saved: bool,
    },
    /// Write this to the peer (a request from the frontend).
    Send(Message),
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
    next_id: AtomicU64,
}

impl WaitRegistry {
    fn new_conn_id(&self) -> ConnId {
        self.next_id.fetch_add(1, Ordering::Relaxed)
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

// ─── Remote agents ─────────────────────────────────────────

/// One connected remote agent: where to send requests and who is waiting
/// for which answer.
pub struct RemoteSession {
    pub host: String,
    /// Directories the agent serves (absolute, on its machine).
    pub roots: Vec<String>,
    tx: Sender<Event>,
    pending: Mutex<HashMap<u64, Sender<Message>>>,
    next_id: AtomicU64,
}

impl RemoteSession {
    /// Send the request `build(id)` and wait for its `Result`.
    pub fn request(&self, build: impl FnOnce(u64) -> Message) -> Result<serde_json::Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (rtx, rrx) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| "session lock poisoned".to_string())?
            .insert(id, rtx);
        if self.tx.send(Event::Send(build(id))).is_err() {
            self.take_pending(id);
            return Err(format!("{}: agent disconnected", self.host));
        }
        match rrx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(Message::Result { ok, error, .. }) => match (ok, error) {
                (_, Some(e)) => Err(e),
                (Some(v), None) => Ok(v),
                (None, None) => Ok(serde_json::Value::Null),
            },
            Ok(_) => Err("unexpected reply".into()),
            Err(_) => {
                self.take_pending(id);
                Err(format!("{}: agent did not answer", self.host))
            }
        }
    }

    fn take_pending(&self, id: u64) -> Option<Sender<Message>> {
        self.pending.lock().ok()?.remove(&id)
    }

    /// Route an incoming `Result` to whoever asked. Returns false if nobody did.
    fn resolve(&self, msg: Message) -> bool {
        let Some(id) = msg.request_id() else {
            return false;
        };
        match self.take_pending(id) {
            Some(tx) => tx.send(msg).is_ok(),
            None => false,
        }
    }

    /// Fail every outstanding request (the agent is gone).
    fn abort_all(&self) {
        if let Ok(mut p) = self.pending.lock() {
            for (id, tx) in p.drain() {
                let _ = tx.send(Message::err(
                    id,
                    format!("{}: agent disconnected", self.host),
                ));
            }
        }
    }

    /// Whether `path` (absolute, on the agent's machine) is under a root.
    fn serves(&self, path: &str) -> Option<usize> {
        self.roots
            .iter()
            .filter(|r| {
                path == r.as_str() || path.starts_with(&format!("{}/", r.trim_end_matches('/')))
            })
            .map(|r| r.len())
            .max()
    }
}

/// The connected remote agents, by host.
#[derive(Default)]
pub struct RemoteSessions {
    by_host: Mutex<HashMap<String, Vec<Arc<RemoteSession>>>>,
}

impl RemoteSessions {
    fn insert(&self, session: Arc<RemoteSession>) {
        if let Ok(mut m) = self.by_host.lock() {
            m.entry(session.host.clone()).or_default().push(session);
        }
    }

    fn remove(&self, session: &Arc<RemoteSession>) {
        if let Ok(mut m) = self.by_host.lock() {
            if let Some(v) = m.get_mut(&session.host) {
                v.retain(|s| !Arc::ptr_eq(s, session));
                if v.is_empty() {
                    m.remove(&session.host);
                }
            }
        }
    }

    /// The agent on `host` best placed to answer for `path`: the one whose
    /// root is the longest match, else the most recent connection.
    pub fn route(&self, host: &str, path: &str) -> Option<Arc<RemoteSession>> {
        let m = self.by_host.lock().ok()?;
        let sessions = m.get(host)?;
        sessions
            .iter()
            .filter_map(|s| s.serves(path).map(|len| (len, s)))
            .max_by_key(|(len, _)| *len)
            .map(|(_, s)| Arc::clone(s))
            .or_else(|| sessions.last().cloned())
    }

    /// Resolve a `remote://host/path` to (session, path on the agent).
    pub fn lookup(&self, remote: &str) -> Result<(Arc<RemoteSession>, String), String> {
        let (host, path) = ipc::split_remote_path(remote)
            .ok_or_else(|| format!("not a remote path: {}", remote))?;
        let session = self
            .route(host, path)
            .ok_or_else(|| format!("{}: no agent connected", host))?;
        Ok((session, path.to_string()))
    }

    pub fn hosts(&self) -> Vec<String> {
        self.by_host
            .lock()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }
}

// ─── Per-connection protocol state ─────────────────────────

/// Protocol state of one connection. `handle` consumes a message and yields
/// the replies to write; `closed` turns a tab closure into a reply.
#[derive(Debug, Default)]
pub struct ConnState {
    /// The secret a remote agent must present (`fude_core::token`). Local
    /// clients (no host) are trusted by the socket's own permissions.
    required_token: Option<String>,
    cwd: Option<String>,
    /// Set when the peer is a remote agent (its hello carried a host).
    host: Option<String>,
    greeted: bool,
    /// Paths still to be reported `Closed`.
    pending: HashSet<String>,
    /// Set once an `Open` was processed; with `wait` the connection ends when
    /// `pending` drains, otherwise right after the replies are written.
    opened: bool,
    wait: bool,
    /// Roots announced by a remote agent in `Open`.
    roots: Vec<String>,
}

impl ConnState {
    pub fn with_token(token: Option<String>) -> ConnState {
        ConnState {
            required_token: token,
            ..Default::default()
        }
    }

    /// Paths this connection asked to wait for (for cleanup on disconnect).
    pub fn pending(&self) -> &HashSet<String> {
        &self.pending
    }

    pub fn host(&self) -> Option<&str> {
        self.host.as_deref()
    }

    pub fn roots(&self) -> &[String] {
        &self.roots
    }

    /// True when nothing more will be sent and the connection can end.
    pub fn finished(&self) -> bool {
        self.opened && (!self.wait || self.pending.is_empty())
    }

    /// The tab path for a client path: resolved locally for a local client,
    /// prefixed with the host for a remote agent (which sends absolute paths
    /// of its own machine; resolving those here would be meaningless).
    fn tab_path(&self, p: &str) -> String {
        match &self.host {
            Some(host) => remote_path(host, p),
            None => fude_core::resolve_cli_path(p, self.cwd.as_ref().map(std::path::PathBuf::from)),
        }
    }

    /// Process one message from the client. The second element lists the
    /// resolved paths the caller must register as waiters.
    pub fn handle(&mut self, msg: Message, sink: &dyn OpenSink) -> (Vec<Message>, Vec<String>) {
        match msg {
            Message::Hello {
                protocol,
                cwd,
                host,
                token,
                ..
            } => {
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
                let host = host.filter(|h| !h.is_empty() && !h.contains('/'));
                if host.is_some() {
                    let ok = match &self.required_token {
                        Some(t) => fude_core::token::matches(t, token.as_deref()),
                        None => false,
                    };
                    if !ok {
                        return (
                            vec![
                                Message::Error {
                                    path: None,
                                    message: "remote agents must present the GUI token \
                                              (copy ~/.config/fude/gui-token from the GUI machine)"
                                        .into(),
                                },
                                Message::Bye,
                            ],
                            vec![],
                        );
                    }
                }
                self.greeted = true;
                self.cwd = cwd;
                self.host = host;
                (
                    vec![Message::Welcome {
                        protocol: PROTOCOL_VERSION,
                        gui_version: Some(env!("CARGO_PKG_VERSION").to_string()),
                    }],
                    vec![],
                )
            }
            Message::Open { paths, wait, roots } => {
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
                self.roots = roots.unwrap_or_default();
                let mut replies = Vec::new();
                let mut register = Vec::new();
                for p in paths {
                    let resolved = self.tab_path(&p);
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
            Message::FileChanged { path } => {
                if let Some(host) = &self.host {
                    sink.file_changed(&remote_path(host, &path));
                }
                (vec![], vec![])
            }
            // Handled by the connection loop (routed to the requester).
            Message::Result { .. } => (vec![], vec![]),
            // Replies and requests are never valid from a client.
            Message::Welcome { .. }
            | Message::Opened { .. }
            | Message::Closed { .. }
            | Message::Error { .. }
            | Message::ReadFile { .. }
            | Message::WriteFile { .. }
            | Message::ReadDirTree { .. }
            | Message::Watch { .. }
            | Message::Unwatch { .. } => (
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

// ─── Listener and connection loop ──────────────────────────

/// Remove a socket file nobody listens on any more (a GUI that was killed
/// never got to unlink it), so the next bind succeeds. A socket that
/// answers is left alone: another Fude owns it. Unix only; named pipes
/// have no corpse to clear.
pub fn clear_stale_socket(socket: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use interprocess::local_socket::Stream;
        if !socket.exists() {
            return Ok(());
        }
        let name = ipc::socket_name(socket).map_err(|e| e.to_string())?;
        match Stream::connect(name) {
            Ok(_) => Err(format!(
                "another Fude is already listening on {}",
                socket.display()
            )),
            Err(_) => std::fs::remove_file(socket)
                .map_err(|e| format!("cannot remove stale socket {}: {}", socket.display(), e)),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = socket;
        Ok(())
    }
}

/// Start listening on `name`. Returns once the socket is bound; connections
/// are served on background threads.
pub fn start(
    name: Name<'static>,
    token: String,
    registry: Arc<WaitRegistry>,
    sessions: Arc<RemoteSessions>,
    sink: Arc<dyn OpenSink>,
) -> io::Result<()> {
    let token = Arc::new(token);
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
                        let sessions = Arc::clone(&sessions);
                        let sink = Arc::clone(&sink);
                        let token = Arc::clone(&token);
                        let _ = thread::Builder::new()
                            .name("fude-gui-ipc-conn".into())
                            .spawn(move || serve(stream, token, registry, sessions, sink));
                    }
                    Err(e) => eprintln!("fude: IPC accept failed: {}", e),
                }
            }
        })?;
    Ok(())
}

fn serve(
    stream: interprocess::local_socket::Stream,
    token: Arc<String>,
    registry: Arc<WaitRegistry>,
    sessions: Arc<RemoteSessions>,
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
    let mut state = ConnState::with_token(Some(token.to_string()));
    let mut session: Option<Arc<RemoteSession>> = None;
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
                    Ok(Some(msg @ Message::Result { .. })) => {
                        if let Some(s) = &session {
                            s.resolve(msg);
                        }
                        continue;
                    }
                    Ok(Some(msg)) => {
                        let was_open = state.opened;
                        let (replies, register) = state.handle(msg, sink.as_ref());
                        for p in register {
                            registry.register(conn_id, &p, tx.clone());
                        }
                        // A remote agent becomes routable once it has told us
                        // what it serves.
                        if !was_open && state.opened && session.is_none() {
                            if let Some(host) = state.host() {
                                let s = Arc::new(RemoteSession {
                                    host: host.to_string(),
                                    roots: state.roots().to_vec(),
                                    tx: tx.clone(),
                                    pending: Mutex::new(HashMap::new()),
                                    next_id: AtomicU64::new(1),
                                });
                                sessions.insert(Arc::clone(&s));
                                session = Some(s);
                            }
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
            Event::Send(msg) => {
                if !write_all(&mut send, &[msg]) {
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
    if let Some(s) = session {
        sessions.remove(&s);
        s.abort_all();
        sink.disconnected(&s.host);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Recorder {
        calls: Mutex<Vec<(String, bool)>>,
        changed: Mutex<Vec<String>>,
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
        fn file_changed(&self, path: &str) {
            self.changed.lock().unwrap().push(path.to_string());
        }
    }

    fn hello(cwd: &str) -> Message {
        Message::Hello {
            protocol: PROTOCOL_VERSION,
            cwd: Some(cwd.into()),
            cli_version: None,
            host: None,
            token: None,
        }
    }

    fn open(paths: &[&str], wait: bool) -> Message {
        Message::Open {
            paths: paths.iter().map(|s| s.to_string()).collect(),
            wait,
            roots: None,
        }
    }

    #[test]
    fn open_with_wait_registers_resolved_paths_and_waits_for_closed() {
        let sink = Recorder::default();
        let mut st = ConnState::default();
        assert!(matches!(
            st.handle(hello("/work"), &sink).0.as_slice(),
            [Message::Welcome { .. }]
        ));

        let (replies, register) = st.handle(open(&["notes.md", "/abs/x.md"], true), &sink);
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
        let (replies, register) = st.handle(open(&["a.md"], false), &sink);
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
        let (replies, register) = st.handle(open(&["bad.md", "good.md"], true), &sink);
        assert_eq!(register, vec!["/w/good.md"]);
        assert!(matches!(&replies[0], Message::Error { path: Some(p), .. } if p == "/w/bad.md"));
        assert!(matches!(&replies[1], Message::Opened { path } if path == "/w/good.md"));
    }

    #[test]
    fn open_before_hello_and_wrong_protocol_are_refused() {
        let sink = Recorder::default();
        let mut st = ConnState::default();
        let (replies, _) = st.handle(open(&["a.md"], true), &sink);
        assert!(matches!(replies[0], Message::Error { .. }));
        assert_eq!(replies[1], Message::Bye);
        assert!(sink.calls.lock().unwrap().is_empty());

        let (replies, _) = st.handle(
            Message::Hello {
                protocol: PROTOCOL_VERSION + 1,
                cwd: None,
                cli_version: None,
                host: None,
                token: None,
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
        st.handle(open(&["a.md"], true), &sink);
        assert!(!st.finished());
        st.handle(Message::Bye, &sink);
        assert!(st.finished());
        assert!(st.pending().is_empty());
    }

    #[test]
    fn requests_from_a_client_are_rejected() {
        let sink = Recorder::default();
        let mut st = ConnState::default();
        st.handle(hello("/w"), &sink);
        let (replies, _) = st.handle(
            Message::ReadFile {
                id: 1,
                path: "/x".into(),
            },
            &sink,
        );
        assert!(matches!(replies[0], Message::Error { .. }));
    }

    #[test]
    fn remote_agents_need_the_token_and_local_clients_do_not() {
        let sink = Recorder::default();
        let mut st = ConnState::with_token(Some("secret".into()));
        for bad in [None, Some("wrong".to_string())] {
            let (replies, _) = st.handle(
                Message::Hello {
                    protocol: PROTOCOL_VERSION,
                    cwd: None,
                    cli_version: None,
                    host: Some("box".into()),
                    token: bad,
                },
                &sink,
            );
            assert!(
                matches!(&replies[0], Message::Error { message, .. } if message.contains("token"))
            );
            assert_eq!(replies[1], Message::Bye);
            assert_eq!(st.host(), None);
        }
        // A local `fude --wait` presents no token and is welcome.
        let (replies, _) = st.handle(hello("/w"), &sink);
        assert!(matches!(replies[0], Message::Welcome { .. }));
        // No token configured at all: remote agents are refused outright.
        let mut none = ConnState::default();
        let (replies, _) = none.handle(
            Message::Hello {
                protocol: PROTOCOL_VERSION,
                cwd: None,
                cli_version: None,
                host: Some("box".into()),
                token: Some("anything".into()),
            },
            &sink,
        );
        assert!(matches!(replies[0], Message::Error { .. }));
    }

    #[test]
    fn remote_agent_paths_are_prefixed_with_the_host_not_resolved() {
        let sink = Recorder::default();
        let mut st = ConnState::with_token(Some("secret".into()));
        st.handle(
            Message::Hello {
                protocol: PROTOCOL_VERSION,
                cwd: Some("/home/u".into()),
                cli_version: None,
                host: Some("box".into()),
                token: Some("secret\n".into()),
            },
            &sink,
        );
        assert_eq!(st.host(), Some("box"));
        let (replies, register) = st.handle(
            Message::Open {
                paths: vec!["/home/u/notes/a.md".into()],
                wait: true,
                roots: Some(vec!["/home/u/notes".into()]),
            },
            &sink,
        );
        assert_eq!(register, vec!["remote://box/home/u/notes/a.md"]);
        assert!(
            matches!(&replies[0], Message::Opened { path } if path == "remote://box/home/u/notes/a.md")
        );
        assert_eq!(st.roots(), &["/home/u/notes".to_string()]);

        st.handle(
            Message::FileChanged {
                path: "/home/u/notes/a.md".into(),
            },
            &sink,
        );
        assert_eq!(
            *sink.changed.lock().unwrap(),
            vec!["remote://box/home/u/notes/a.md".to_string()]
        );
        assert!(st.closed("remote://box/home/u/notes/a.md", true).is_some());
        assert!(st.finished());
    }

    #[test]
    fn a_host_with_a_slash_is_ignored() {
        let sink = Recorder::default();
        let mut st = ConnState::with_token(Some("secret".into()));
        st.handle(
            Message::Hello {
                protocol: PROTOCOL_VERSION,
                cwd: None,
                cli_version: None,
                host: Some("evil/host".into()),
                token: Some("secret".into()),
            },
            &sink,
        );
        assert_eq!(st.host(), None);
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

    #[cfg(unix)]
    #[test]
    fn stale_socket_files_are_removed_and_live_ones_kept() {
        let tmp = tempfile::TempDir::new().unwrap();
        let sock = tmp.path().join("gui.sock");
        assert!(clear_stale_socket(&sock).is_ok()); // nothing there

        // A corpse: bound once, listener dropped without unlinking.
        {
            let name = ipc::socket_name(&sock).unwrap();
            let l = ListenerOptions::new()
                .name(name)
                .reclaim_name(false)
                .create_sync()
                .unwrap();
            drop(l);
        }
        assert!(sock.exists());
        assert!(clear_stale_socket(&sock).is_ok());
        assert!(!sock.exists());

        // A live listener must be left alone.
        let name = ipc::socket_name(&sock).unwrap();
        let _live = ListenerOptions::new().name(name).create_sync().unwrap();
        let e = clear_stale_socket(&sock).unwrap_err();
        assert!(e.contains("another Fude"));
        assert!(sock.exists());
    }

    fn session(host: &str, roots: &[&str]) -> (Arc<RemoteSession>, mpsc::Receiver<Event>) {
        let (tx, rx) = mpsc::channel();
        (
            Arc::new(RemoteSession {
                host: host.into(),
                roots: roots.iter().map(|s| s.to_string()).collect(),
                tx,
                pending: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
            }),
            rx,
        )
    }

    #[test]
    fn remote_request_roundtrips_through_the_connection_channel() {
        let (s, rx) = session("box", &["/r"]);
        let s2 = Arc::clone(&s);
        let answer = thread::spawn(move || {
            let Ok(Event::Send(Message::ReadFile { id, path })) = rx.recv() else {
                panic!("expected a read request");
            };
            assert_eq!(path, "/r/a.md");
            assert!(s2.resolve(Message::ok(id, serde_json::json!("content"))));
        });
        let v = s
            .request(|id| Message::ReadFile {
                id,
                path: "/r/a.md".into(),
            })
            .unwrap();
        assert_eq!(v, serde_json::json!("content"));
        answer.join().unwrap();
        // Nothing left pending; an unsolicited result is dropped.
        assert!(!s.resolve(Message::ok(99, serde_json::Value::Null)));
    }

    #[test]
    fn remote_request_errors_propagate_and_disconnect_aborts() {
        let (s, rx) = session("box", &["/r"]);
        let s2 = Arc::clone(&s);
        thread::spawn(move || {
            let Ok(Event::Send(m)) = rx.recv() else {
                return;
            };
            s2.resolve(Message::err(m.request_id().unwrap(), "nope"));
        });
        let e = s
            .request(|id| Message::ReadFile {
                id,
                path: "/r/a.md".into(),
            })
            .unwrap_err();
        assert_eq!(e, "nope");

        let (s, rx) = session("box", &["/r"]);
        drop(rx);
        let e = s
            .request(|id| Message::ReadFile {
                id,
                path: "/r/a.md".into(),
            })
            .unwrap_err();
        assert!(e.contains("disconnected"));
    }

    #[test]
    fn sessions_route_by_longest_root_then_fall_back_to_the_latest() {
        let reg = RemoteSessions::default();
        let (a, _ra) = session("box", &["/home/u"]);
        let (b, _rb) = session("box", &["/home/u/notes"]);
        let (c, _rc) = session("other", &["/x"]);
        reg.insert(Arc::clone(&a));
        reg.insert(Arc::clone(&b));
        reg.insert(Arc::clone(&c));
        assert!(Arc::ptr_eq(
            &reg.route("box", "/home/u/notes/a.md").unwrap(),
            &b
        ));
        assert!(Arc::ptr_eq(&reg.route("box", "/home/u/x.md").unwrap(), &a));
        // Not under any root: the most recent agent for that host gets it.
        assert!(Arc::ptr_eq(&reg.route("box", "/etc/hosts").unwrap(), &b));
        // Prefix that is not a path boundary does not match.
        assert!(Arc::ptr_eq(
            &reg.route("box", "/home/u/notes2/a.md").unwrap(),
            &a
        ));
        assert!(reg.route("nobody", "/x").is_none());

        let (s, p) = reg.lookup("remote://other/x/f.md").unwrap();
        assert!(Arc::ptr_eq(&s, &c));
        assert_eq!(p, "/x/f.md");
        assert!(reg.lookup("/local").is_err());

        reg.remove(&b);
        assert!(Arc::ptr_eq(
            &reg.route("box", "/home/u/notes/a.md").unwrap(),
            &a
        ));
        let mut hosts = reg.hosts();
        hosts.sort();
        assert_eq!(hosts, vec!["box", "other"]);
    }
}
