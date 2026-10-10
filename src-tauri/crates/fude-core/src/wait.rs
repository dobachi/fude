//! Client-side bookkeeping for "open these paths and wait until their tabs
//! close": shared by `fude --wait` and the `fude-cli` agent.

use crate::ipc::Message;

/// Outcome of one waited path.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Closed { saved: bool },
    Failed(String),
}

/// Process exit code: 0 only when every tab closed with its content saved
/// (or unchanged). Discarded edits and paths the GUI could not open are
/// failures, so a caller like `git commit` treats them as an abort.
pub fn exit_code(outcomes: &[Outcome]) -> i32 {
    if outcomes
        .iter()
        .all(|o| matches!(o, Outcome::Closed { saved: true }))
    {
        0
    } else {
        1
    }
}

/// Tracks `Opened` / `Closed` / `Error` replies until every requested path
/// has an outcome.
#[derive(Debug, Default)]
pub struct WaitState {
    outcomes: Vec<(String, Outcome)>,
    /// Paths we have been told are open but not yet closed.
    open: Vec<String>,
    /// Count of paths we asked for; `Opened`/`Error` each account for one.
    expected: usize,
    done: bool,
}

impl WaitState {
    pub fn new(expected: usize) -> Self {
        WaitState {
            expected,
            ..Default::default()
        }
    }

    pub fn outcomes(&self) -> Vec<Outcome> {
        self.outcomes.iter().map(|(_, o)| o.clone()).collect()
    }

    pub fn done(&self) -> bool {
        self.done
    }

    /// Feed one message. Returns a line to show the user, if any. Messages
    /// unrelated to waiting (file requests etc.) are ignored here.
    pub fn handle(&mut self, msg: &Message) -> Option<String> {
        match msg {
            Message::Opened { path } => {
                self.open.push(path.clone());
                None
            }
            Message::Closed { path, saved } => {
                self.open.retain(|p| p != path);
                self.outcomes
                    .push((path.clone(), Outcome::Closed { saved: *saved }));
                self.check_done();
                None
            }
            Message::Error { path, message } => {
                let shown = match path {
                    Some(p) => format!("fude: {}: {}", p, message),
                    None => format!("fude: {}", message),
                };
                self.outcomes.push((
                    path.clone().unwrap_or_default(),
                    Outcome::Failed(message.clone()),
                ));
                self.check_done();
                Some(shown)
            }
            Message::Bye => {
                self.done = true;
                None
            }
            _ => None,
        }
    }

    /// The GUI hung up. Paths still open count as closed-and-saved: the GUI
    /// quit, and quitting already prompts about unsaved changes.
    pub fn disconnected(&mut self) {
        for p in self.open.drain(..) {
            self.outcomes.push((p, Outcome::Closed { saved: true }));
        }
        self.done = true;
    }

    fn check_done(&mut self) {
        if self.outcomes.len() >= self.expected && self.open.is_empty() {
            self.done = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_code_is_zero_only_when_everything_was_saved() {
        assert_eq!(exit_code(&[Outcome::Closed { saved: true }]), 0);
        assert_eq!(
            exit_code(&[
                Outcome::Closed { saved: true },
                Outcome::Closed { saved: false }
            ]),
            1
        );
        assert_eq!(exit_code(&[Outcome::Failed("x".into())]), 1);
        assert_eq!(exit_code(&[]), 0);
    }

    #[test]
    fn wait_state_completes_when_every_path_is_closed() {
        let mut st = WaitState::new(2);
        st.handle(&Message::Opened { path: "/a".into() });
        st.handle(&Message::Opened { path: "/b".into() });
        assert!(!st.done());
        st.handle(&Message::Closed {
            path: "/a".into(),
            saved: true,
        });
        assert!(!st.done());
        st.handle(&Message::Closed {
            path: "/b".into(),
            saved: false,
        });
        assert!(st.done());
        assert_eq!(exit_code(&st.outcomes()), 1);
    }

    #[test]
    fn wait_state_counts_errors_toward_completion() {
        let mut st = WaitState::new(2);
        let shown = st.handle(&Message::Error {
            path: Some("/bad".into()),
            message: "cannot open".into(),
        });
        assert_eq!(shown.as_deref(), Some("fude: /bad: cannot open"));
        st.handle(&Message::Opened { path: "/ok".into() });
        assert!(!st.done());
        st.handle(&Message::Closed {
            path: "/ok".into(),
            saved: true,
        });
        assert!(st.done());
        assert_eq!(exit_code(&st.outcomes()), 1);
    }

    #[test]
    fn wait_state_treats_a_hangup_as_saved() {
        let mut st = WaitState::new(1);
        st.handle(&Message::Opened { path: "/a".into() });
        st.disconnected();
        assert!(st.done());
        assert_eq!(st.outcomes(), vec![Outcome::Closed { saved: true }]);
    }

    #[test]
    fn bye_from_the_gui_ends_the_wait() {
        let mut st = WaitState::new(1);
        st.handle(&Message::Bye);
        assert!(st.done());
    }

    #[test]
    fn file_requests_do_not_disturb_the_wait() {
        let mut st = WaitState::new(1);
        st.handle(&Message::Opened { path: "/a".into() });
        assert!(st
            .handle(&Message::ReadFile {
                id: 1,
                path: "/a".into()
            })
            .is_none());
        assert!(!st.done());
    }
}
