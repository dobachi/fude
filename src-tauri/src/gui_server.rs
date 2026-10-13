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
    /// A remote agent reports that something under the watched directory
    /// `path` (already `remote://...`) was added, removed or changed.
    fn dir_changed(&self, _path: &str) {}
    /// The agent for `host` went away.
    fn disconnected(&self, _host: &str) {}
    /// The agent for `host` runs fude-cli `cli_version`, older than this GUI.
    fn cli_outdated(&self, _host: &str, _cli_version: &str) {}
}

fn version_triple(v: &str) -> Option<(u64, u64, u64)> {
    let mut it = v.trim().split('.').map(|p| p.parse::<u64>().ok());
    let triple = (it.next()??, it.next()??, it.next()??);
    it.next().is_none().then_some(triple)
}

/// `cli` when it is a version older than `gui`. A version that cannot be
/// read, an equal one and a newer one (the GUI is what is behind then) all
/// give None.
pub fn older_cli<'a>(cli: Option<&'a str>, gui: &str) -> Option<&'a str> {
    let cli = cli?;
    (version_triple(cli)? < version_triple(gui)?).then_some(cli)
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
    /// The user asked to disconnect: say goodbye and end the connection.
    Hangup,
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
    /// Identifies the session to the frontend (to disconnect it).
    pub id: u64,
    /// How this application reached the agent when it started it itself
    /// (`ssh:<host>` or `wsl`), so that another place can be opened the
    /// same way. None for an agent that connected on its own.
    pub origin: Option<String>,
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

    /// Every connected agent as (id, host, roots, origin), in a stable order.
    pub fn list(&self) -> Vec<(u64, String, Vec<String>, Option<String>)> {
        let mut all: Vec<_> = self
            .by_host
            .lock()
            .map(|m| {
                m.values()
                    .flatten()
                    .map(|s| (s.id, s.host.clone(), s.roots.clone(), s.origin.clone()))
                    .collect()
            })
            .unwrap_or_default();
        all.sort_by_key(|(id, ..)| *id);
        all
    }

    /// End the session `id`. Its tabs stay; they cannot be saved until the
    /// host is connected again. False when there is no such session.
    pub fn hang_up(&self, id: u64) -> bool {
        let session = self
            .by_host
            .lock()
            .ok()
            .and_then(|m| m.values().flatten().find(|s| s.id == id).cloned());
        match session {
            Some(s) => s.tx.send(Event::Hangup).is_ok(),
            None => false,
        }
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
    /// Demand the token from every client, host or not: set for connections
    /// that arrived over TCP, where the socket's file permissions protect
    /// nothing.
    token_always: bool,
    /// Set for peers we spawned (`trusted`): no token is asked for.
    trusted: bool,
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

    /// For a peer this application started itself: a remote agent (its
    /// hello names a host) is accepted without a token.
    pub fn trusted() -> ConnState {
        ConnState {
            trusted: true,
            ..Default::default()
        }
    }

    /// Like `with_token`, but local clients must present it as well.
    pub fn with_token_always(token: Option<String>) -> ConnState {
        ConnState {
            required_token: token,
            token_always: true,
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
                cli_version,
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
                if !self.trusted && (host.is_some() || self.token_always) {
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
                if let (Some(h), Some(v)) = (
                    host.as_deref(),
                    older_cli(cli_version.as_deref(), env!("CARGO_PKG_VERSION")),
                ) {
                    sink.cli_outdated(h, v);
                }
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
            Message::DirChanged { path } => {
                if let Some(host) = &self.host {
                    sink.dir_changed(&remote_path(host, &path));
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
            | Message::Unwatch { .. }
            | Message::WatchDir { .. }
            | Message::UnwatchDir { .. } => (
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

/// Also listen on a loopback TCP address. This is what an ssh
/// `RemoteForward 47821 127.0.0.1:47821` from a Windows client reaches
/// (ssh cannot forward to a named pipe), and what a WSL `fude-cli` uses to
/// reach the Windows GUI. Anyone on this machine can connect, so every
/// client here must present the token.
pub fn start_tcp(
    addr: &str,
    token: String,
    registry: Arc<WaitRegistry>,
    sessions: Arc<RemoteSessions>,
    sink: Arc<dyn OpenSink>,
) -> io::Result<std::net::SocketAddr> {
    let token = Arc::new(token);
    let listener = std::net::TcpListener::bind(addr)?;
    let bound = listener.local_addr()?;
    thread::Builder::new()
        .name("fude-gui-tcp".into())
        .spawn(move || {
            for conn in listener.incoming() {
                match conn {
                    Ok(stream) => {
                        let _ = stream.set_nodelay(true);
                        let Ok(w) = stream.try_clone() else { continue };
                        let registry = Arc::clone(&registry);
                        let sessions = Arc::clone(&sessions);
                        let sink = Arc::clone(&sink);
                        let token = Arc::clone(&token);
                        let _ = thread::Builder::new()
                            .name("fude-gui-tcp-conn".into())
                            .spawn(move || {
                                serve(
                                    Box::new(stream),
                                    Box::new(w),
                                    Peer {
                                        token: Some(token),
                                        token_always: true,
                                        origin: None,
                                    },
                                    registry,
                                    sessions,
                                    sink,
                                )
                            });
                    }
                    Err(e) => eprintln!("fude: TCP accept failed: {}", e),
                }
            }
        })?;
    Ok(bound)
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
                        let (recv, send) = stream.split();
                        let registry = Arc::clone(&registry);
                        let sessions = Arc::clone(&sessions);
                        let sink = Arc::clone(&sink);
                        let token = Arc::clone(&token);
                        let _ = thread::Builder::new()
                            .name("fude-gui-ipc-conn".into())
                            .spawn(move || {
                                serve(
                                    Box::new(recv),
                                    Box::new(send),
                                    Peer {
                                        token: Some(token),
                                        token_always: false,
                                        origin: None,
                                    },
                                    registry,
                                    sessions,
                                    sink,
                                )
                            });
                    }
                    Err(e) => eprintln!("fude: IPC accept failed: {}", e),
                }
            }
        })?;
    Ok(())
}

/// Serve an agent this application started itself, over the pipes to it
/// (`recv` its stdout, `send` its stdin). No token is asked for: nobody
/// else can be at the other end of a pipe we opened. Returns when the
/// connection ends. `origin` records how the agent was reached.
pub fn serve_child(
    recv: Box<dyn std::io::Read + Send>,
    send: Box<dyn Write + Send>,
    origin: String,
    registry: Arc<WaitRegistry>,
    sessions: Arc<RemoteSessions>,
    sink: Arc<dyn OpenSink>,
) {
    let peer = Peer {
        token: None,
        token_always: false,
        origin: Some(origin),
    };
    serve(recv, send, peer, registry, sessions, sink)
}

/// What is known about the other end of a connection before it speaks.
struct Peer {
    /// The secret it must present; None for an agent we started ourselves.
    token: Option<Arc<String>>,
    /// Whether even a local client must present it (TCP).
    token_always: bool,
    /// How we reached it, when we started it (`RemoteSession::origin`).
    origin: Option<String>,
}

fn serve(
    recv: Box<dyn std::io::Read + Send>,
    mut send: Box<dyn Write + Send>,
    peer: Peer,
    registry: Arc<WaitRegistry>,
    sessions: Arc<RemoteSessions>,
    sink: Arc<dyn OpenSink>,
) {
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
    let Peer {
        token,
        token_always,
        origin,
    } = peer;
    let mut state = match token {
        Some(token) if token_always => ConnState::with_token_always(Some(token.to_string())),
        Some(token) => ConnState::with_token(Some(token.to_string())),
        None => ConnState::trusted(),
    };
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
                                    id: conn_id,
                                    origin: origin.clone(),
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
            Event::Hangup => {
                let _ = write_all(&mut send, &[Message::Bye]);
                break;
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
        dirs_changed: Mutex<Vec<String>>,
        outdated: Mutex<Vec<(String, String)>>,
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
        fn dir_changed(&self, path: &str) {
            self.dirs_changed.lock().unwrap().push(path.to_string());
        }
        fn cli_outdated(&self, host: &str, cli_version: &str) {
            self.outdated
                .lock()
                .unwrap()
                .push((host.to_string(), cli_version.to_string()));
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

    // Local paths are resolved with the host OS's separator; these spell
    // out Unix results (the resolution itself is tested in fude_core::cli).
    #[cfg(not(windows))]
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

    // Local paths are resolved with the host OS's separator; these spell
    // out Unix results (the resolution itself is tested in fude_core::cli).
    #[cfg(not(windows))]
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

    // Local paths are resolved with the host OS's separator; these spell
    // out Unix results (the resolution itself is tested in fude_core::cli).
    #[cfg(not(windows))]
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
                base64: false,
            },
            &sink,
        );
        assert!(matches!(replies[0], Message::Error { .. }));
    }

    #[test]
    fn an_agent_we_started_ourselves_needs_no_token() {
        let sink = Recorder::default();
        let mut st = ConnState::trusted();
        let (replies, _) = st.handle(
            Message::Hello {
                protocol: PROTOCOL_VERSION,
                cwd: None,
                cli_version: None,
                host: Some("box".into()),
                token: None,
            },
            &sink,
        );
        assert!(matches!(replies[0], Message::Welcome { .. }), "{replies:?}");
        assert_eq!(st.host(), Some("box"));
    }

    /// The whole life of a connection the app opened itself: greeted
    /// without a token, listed once it serves something, ended on request.
    #[test]
    fn a_child_agent_is_served_listed_and_hung_up_on() {
        use std::io::BufRead;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let agent = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (gui_side, _) = listener.accept().unwrap();
        let registry = Arc::new(WaitRegistry::default());
        let sessions = Arc::new(RemoteSessions::default());
        let sink = Arc::new(Recorder::default());
        let server = {
            let (registry, sessions, sink) = (
                Arc::clone(&registry),
                Arc::clone(&sessions),
                Arc::clone(&sink),
            );
            let w = gui_side.try_clone().unwrap();
            thread::spawn(move || {
                serve_child(
                    Box::new(gui_side),
                    Box::new(w),
                    "ssh:me@k16".into(),
                    registry,
                    sessions,
                    sink,
                )
            })
        };
        let mut to_gui = agent.try_clone().unwrap();
        let mut from_gui = BufReader::new(agent);
        let mut read = || {
            let mut line = String::new();
            from_gui.read_line(&mut line).unwrap();
            ipc::decode(&line).unwrap()
        };
        to_gui
            .write_all(
                ipc::encode(&Message::Hello {
                    protocol: PROTOCOL_VERSION,
                    cwd: None,
                    cli_version: Some(env!("CARGO_PKG_VERSION").into()),
                    host: Some("k16".into()),
                    token: None,
                })
                .as_bytes(),
            )
            .unwrap();
        assert!(matches!(read(), Some(Message::Welcome { .. })));
        assert!(sessions.list().is_empty(), "nothing is served yet");
        to_gui
            .write_all(
                ipc::encode(&Message::Open {
                    paths: vec!["/home/u/notes".into()],
                    wait: true,
                    roots: Some(vec!["/home/u/notes".into()]),
                })
                .as_bytes(),
            )
            .unwrap();
        // The open is acknowledged once the sink has it.
        let _ = read();
        assert_eq!(
            sink.calls.lock().unwrap().as_slice(),
            [("remote://k16/home/u/notes".to_string(), true)]
        );
        let listed = sessions.list();
        assert_eq!(listed.len(), 1);
        let (id, host, roots, origin) = listed[0].clone();
        assert_eq!(origin.as_deref(), Some("ssh:me@k16"));
        assert_eq!(
            (host.as_str(), roots.as_slice()),
            ("k16", ["/home/u/notes".to_string()].as_slice())
        );

        assert!(!sessions.hang_up(id + 999), "no such session");
        assert!(sessions.hang_up(id));
        // The agent is told goodbye, then the line goes quiet.
        loop {
            match read() {
                Some(Message::Bye) => break,
                Some(_) => continue,
                None => panic!("the connection ended without a goodbye"),
            }
        }
        server.join().unwrap();
        assert!(sessions.list().is_empty());
        assert!(!sessions.hang_up(id), "already gone");
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
    fn tcp_connections_demand_the_token_from_everyone() {
        let sink = Recorder::default();
        let mut st = ConnState::with_token_always(Some("secret".into()));
        let (replies, _) = st.handle(hello("/w"), &sink);
        assert!(matches!(replies[0], Message::Error { .. }));
        let (replies, _) = st.handle(
            Message::Hello {
                protocol: PROTOCOL_VERSION,
                cwd: None,
                cli_version: None,
                host: None,
                token: Some("secret".into()),
            },
            &sink,
        );
        assert!(matches!(replies[0], Message::Welcome { .. }));
    }

    #[test]
    fn only_a_readable_older_version_counts_as_outdated() {
        assert_eq!(older_cli(Some("0.8.5"), "0.8.6"), Some("0.8.5"));
        assert_eq!(older_cli(Some("0.1.0"), "0.8.6"), Some("0.1.0"));
        // Numeric, not textual: 0.10.0 is newer than 0.9.0.
        assert_eq!(older_cli(Some("0.9.0"), "0.10.0"), Some("0.9.0"));
        assert_eq!(older_cli(Some("0.10.0"), "0.9.0"), None);
        assert_eq!(older_cli(Some("0.8.6"), "0.8.6"), None);
        assert_eq!(older_cli(Some("0.8.7"), "0.8.6"), None);
        assert_eq!(older_cli(None, "0.8.6"), None);
        for odd in ["", "x", "0.8", "0.8.6.1", "0.8.x", "v0.8.5"] {
            assert_eq!(older_cli(Some(odd), "0.8.6"), None, "{:?}", odd);
        }
        assert_eq!(older_cli(Some("0.8.5"), "dev"), None);
    }

    #[test]
    fn an_older_remote_agent_is_reported_once_it_is_let_in() {
        let agent_hello = |version: Option<&str>, host: Option<&str>, token: &str| Message::Hello {
            protocol: PROTOCOL_VERSION,
            cwd: None,
            cli_version: version.map(str::to_string),
            host: host.map(str::to_string),
            token: Some(token.into()),
        };
        let sink = Recorder::default();
        // Older and admitted: reported, with its host.
        let mut st = ConnState::with_token(Some("secret".into()));
        st.handle(agent_hello(Some("0.0.1"), Some("box"), "secret"), &sink);
        assert_eq!(
            *sink.outdated.lock().unwrap(),
            vec![("box".to_string(), "0.0.1".to_string())]
        );
        // Same version, no version, a local client, a refused agent: silent.
        let current = env!("CARGO_PKG_VERSION");
        for (version, host, token) in [
            (Some(current), Some("box"), "secret"),
            (None, Some("box"), "secret"),
            (Some("0.0.1"), None, "secret"),
            (Some("0.0.1"), Some("box"), "wrong"),
        ] {
            let mut st = ConnState::with_token(Some("secret".into()));
            st.handle(agent_hello(version, host, token), &sink);
        }
        assert_eq!(sink.outdated.lock().unwrap().len(), 1);
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
        // A change in the folder is passed on under the tree's remote path,
        // and is not mistaken for a change of a file.
        st.handle(
            Message::DirChanged {
                path: "/home/u/notes".into(),
            },
            &sink,
        );
        assert_eq!(
            *sink.dirs_changed.lock().unwrap(),
            vec!["remote://box/home/u/notes".to_string()]
        );
        assert_eq!(sink.changed.lock().unwrap().len(), 1);
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
                id: 0,
                origin: None,
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
            let Ok(Event::Send(Message::ReadFile { id, path, .. })) = rx.recv() else {
                panic!("expected a read request");
            };
            assert_eq!(path, "/r/a.md");
            assert!(s2.resolve(Message::ok(id, serde_json::json!("content"))));
        });
        let v = s
            .request(|id| Message::ReadFile {
                id,
                path: "/r/a.md".into(),
                base64: false,
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
                base64: false,
            })
            .unwrap_err();
        assert_eq!(e, "nope");

        let (s, rx) = session("box", &["/r"]);
        drop(rx);
        let e = s
            .request(|id| Message::ReadFile {
                id,
                path: "/r/a.md".into(),
                base64: false,
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
