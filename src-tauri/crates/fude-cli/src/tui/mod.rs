//! The terminal UI. v0 is a viewer: render a Markdown file and follow it as
//! it changes on disk (docs/TUI_DESIGN.md §5, roadmap step 3).

pub mod render;

use crate::agent::Side;
use crate::watch::Watcher;
use ratatui::crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyModifiers,
    MouseEventKind,
};
use ratatui::crossterm::execute;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Widget};
use ratatui::Frame;
use render::Rendered;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

/// Viewer state, kept separate from the terminal so key handling and
/// rendering can be tested with a `TestBackend`.
pub struct Viewer {
    pub path: PathBuf,
    source: String,
    rendered: Rendered,
    rendered_width: u16,
    pub scroll: usize,
    /// Rows available for the document (set on each draw).
    page: usize,
    pub status: String,
    pub quit: bool,
}

/// What a key or mouse event asks for.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Action {
    None,
    Quit,
    ScrollBy(i32),
    HalfPage(i32),
    Page(i32),
    Top,
    Bottom,
    Reload,
}

/// Map an input event to an action. Vim-ish keys plus the arrows; Ctrl+C
/// always quits because raw mode swallows the signal.
pub fn action_for(ev: &Event) -> Action {
    match ev {
        Event::Key(KeyEvent {
            code, modifiers, ..
        }) if ev.is_key_press() => {
            let ctrl = modifiers.contains(KeyModifiers::CONTROL);
            match (code, ctrl) {
                (KeyCode::Char('c'), true) | (KeyCode::Char('q'), false) | (KeyCode::Esc, _) => {
                    Action::Quit
                }
                (KeyCode::Char('j'), false) | (KeyCode::Down, _) | (KeyCode::Enter, _) => {
                    Action::ScrollBy(1)
                }
                (KeyCode::Char('k'), false) | (KeyCode::Up, _) => Action::ScrollBy(-1),
                (KeyCode::Char('d'), true) => Action::HalfPage(1),
                (KeyCode::Char('u'), true) => Action::HalfPage(-1),
                (KeyCode::Char('f'), true)
                | (KeyCode::PageDown, _)
                | (KeyCode::Char(' '), false) => Action::Page(1),
                (KeyCode::Char('b'), true) | (KeyCode::PageUp, _) => Action::Page(-1),
                (KeyCode::Char('g'), false) | (KeyCode::Home, _) => Action::Top,
                (KeyCode::Char('G'), false) | (KeyCode::End, _) => Action::Bottom,
                (KeyCode::Char('r'), false) => Action::Reload,
                _ => Action::None,
            }
        }
        Event::Mouse(m) => match m.kind {
            MouseEventKind::ScrollDown => Action::ScrollBy(3),
            MouseEventKind::ScrollUp => Action::ScrollBy(-3),
            _ => Action::None,
        },
        _ => Action::None,
    }
}

impl Viewer {
    pub fn new(path: &Path, source: String) -> Viewer {
        Viewer {
            path: path.to_path_buf(),
            source,
            rendered: Rendered::default(),
            rendered_width: 0,
            scroll: 0,
            page: 1,
            status: String::new(),
            quit: false,
        }
    }

    /// Replace the document (external change or `r`), keeping the position.
    pub fn set_source(&mut self, source: String) {
        self.source = source;
        self.rendered_width = 0;
    }

    pub fn reload(&mut self) {
        match std::fs::read_to_string(&self.path) {
            Ok(s) => {
                self.set_source(s);
                self.status = "reloaded".into();
            }
            Err(e) => self.status = format!("reload failed: {}", e),
        }
    }

    fn ensure_rendered(&mut self, width: u16) {
        if self.rendered_width != width {
            self.rendered = render::render(&self.source, width);
            self.rendered_width = width;
            self.clamp();
        }
    }

    fn max_scroll(&self) -> usize {
        self.rendered.lines.len().saturating_sub(self.page)
    }

    fn clamp(&mut self) {
        self.scroll = self.scroll.min(self.max_scroll());
    }

    pub fn apply(&mut self, action: Action) {
        let step = |v: &mut Viewer, n: i32| {
            v.scroll = if n < 0 {
                v.scroll.saturating_sub((-n) as usize)
            } else {
                v.scroll + n as usize
            };
        };
        match action {
            Action::None => {}
            Action::Quit => self.quit = true,
            Action::ScrollBy(n) => step(self, n),
            Action::HalfPage(n) => step(self, n * (self.page as i32 / 2).max(1)),
            Action::Page(n) => step(self, n * (self.page as i32 - 1).max(1)),
            Action::Top => self.scroll = 0,
            Action::Bottom => self.scroll = usize::MAX / 2,
            Action::Reload => self.reload(),
        }
        self.clamp();
    }

    /// Draw into `area`: the document above a one-line status bar.
    pub fn draw(&mut self, frame: &mut Frame) {
        let [body, bar] =
            Layout::vertical([Constraint::Min(1), Constraint::Length(1)]).areas(frame.area());
        self.page = body.height.max(1) as usize;
        self.ensure_rendered(body.width);
        self.clamp();

        let visible: Vec<Line<'static>> = self
            .rendered
            .lines
            .iter()
            .skip(self.scroll)
            .take(self.page)
            .map(|l| l.line.clone())
            .collect();
        Paragraph::new(visible).render(body, frame.buffer_mut());
        self.status_bar().render(bar, frame.buffer_mut());
    }

    fn status_bar(&self) -> Paragraph<'static> {
        let total = self.rendered.lines.len();
        let pos = if total == 0 {
            "empty".to_string()
        } else {
            let last = (self.scroll + self.page).min(total);
            format!("{}-{}/{}", self.scroll + 1, last, total)
        };
        let name = self
            .path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let left = format!(" {}  {}", name, pos);
        let right = if self.status.is_empty() {
            "q: quit  j/k: scroll  r: reload  watching ".to_string()
        } else {
            format!("{}  ", self.status)
        };
        let style = Style::default().bg(Color::DarkGray).fg(Color::White);
        Paragraph::new(Line::from(vec![
            Span::styled(left, style.add_modifier(Modifier::BOLD)),
            Span::styled(" ".to_string(), style),
            Span::styled(right, style),
        ]))
        .style(style)
        .right_aligned_if(false)
    }
}

/// Minor helper so the status bar builder reads as one chain.
trait RightAlignedIf {
    fn right_aligned_if(self, yes: bool) -> Self;
}
impl RightAlignedIf for Paragraph<'_> {
    fn right_aligned_if(self, yes: bool) -> Self {
        if yes {
            self.right_aligned()
        } else {
            self
        }
    }
}

/// Run the viewer on `path` until the user quits. Returns the exit code.
pub fn run_viewer(path: &Path) -> i32 {
    let source = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("fude-cli: cannot read {}: {}", path.display(), e);
            return 2;
        }
    };
    let mut viewer = Viewer::new(path, source);

    let (wtx, wrx) = mpsc::channel::<PathBuf>();
    let mut watcher = Watcher::new(wtx).ok();
    if let Some(w) = watcher.as_mut() {
        if let Err(e) = w.watch(path) {
            viewer.status = e;
        }
    } else {
        viewer.status = "file watching unavailable".into();
    }

    let mut terminal = match ratatui::try_init() {
        Ok(t) => t,
        Err(e) => {
            eprintln!("fude-cli: cannot start the terminal UI: {}", e);
            return 2;
        }
    };
    let _ = execute!(std::io::stdout(), EnableMouseCapture);

    let code = loop {
        if terminal.draw(|f| viewer.draw(f)).is_err() {
            break 2;
        }
        match event::poll(Duration::from_millis(100)) {
            Ok(true) => match event::read() {
                Ok(ev) => viewer.apply(action_for(&ev)),
                Err(_) => break 2,
            },
            Ok(false) => {}
            Err(_) => break 2,
        }
        let mut changed = false;
        while wrx.try_recv().is_ok() {
            changed = true;
        }
        if changed {
            viewer.reload();
        }
        if viewer.quit {
            break 0;
        }
    };

    let _ = execute!(std::io::stdout(), DisableMouseCapture);
    ratatui::restore();
    let _ = Rect::default();
    code
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::crossterm::event::{KeyEventKind, KeyEventState};
    use ratatui::Terminal;

    fn key(code: KeyCode, modifiers: KeyModifiers) -> Event {
        Event::Key(KeyEvent {
            code,
            modifiers,
            kind: KeyEventKind::Press,
            state: KeyEventState::NONE,
        })
    }

    #[test]
    fn keys_map_to_vim_like_actions() {
        assert_eq!(
            action_for(&key(KeyCode::Char('q'), KeyModifiers::NONE)),
            Action::Quit
        );
        assert_eq!(
            action_for(&key(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            Action::Quit
        );
        assert_eq!(
            action_for(&key(KeyCode::Char('j'), KeyModifiers::NONE)),
            Action::ScrollBy(1)
        );
        assert_eq!(
            action_for(&key(KeyCode::Up, KeyModifiers::NONE)),
            Action::ScrollBy(-1)
        );
        assert_eq!(
            action_for(&key(KeyCode::Char('d'), KeyModifiers::CONTROL)),
            Action::HalfPage(1)
        );
        assert_eq!(
            action_for(&key(KeyCode::Char('G'), KeyModifiers::NONE)),
            Action::Bottom
        );
        assert_eq!(
            action_for(&key(KeyCode::Char('x'), KeyModifiers::NONE)),
            Action::None
        );
        // A release of `q` is not a quit.
        let release = Event::Key(KeyEvent {
            code: KeyCode::Char('q'),
            modifiers: KeyModifiers::NONE,
            kind: KeyEventKind::Release,
            state: KeyEventState::NONE,
        });
        assert_eq!(action_for(&release), Action::None);
    }

    fn doc(n: usize) -> String {
        (1..=n)
            .map(|i| format!("line {}\n", i))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn scrolling_is_clamped_to_the_document() {
        let mut v = Viewer::new(Path::new("/x.md"), doc(10));
        let backend = TestBackend::new(20, 5);
        let mut t = Terminal::new(backend).unwrap();
        t.draw(|f| v.draw(f)).unwrap();
        // 4 body rows + 1 status row; 10 paragraphs = 19 rendered lines.
        assert_eq!(v.page, 4);
        v.apply(Action::ScrollBy(-5));
        assert_eq!(v.scroll, 0);
        v.apply(Action::Bottom);
        assert_eq!(v.scroll, 19 - 4);
        v.apply(Action::ScrollBy(1));
        assert_eq!(v.scroll, 15);
        v.apply(Action::Top);
        v.apply(Action::Page(1));
        assert_eq!(v.scroll, 3);
        v.apply(Action::HalfPage(1));
        assert_eq!(v.scroll, 5);
        v.apply(Action::Quit);
        assert!(v.quit);
    }

    #[test]
    fn draw_shows_the_document_and_a_status_bar() {
        let mut v = Viewer::new(Path::new("/notes/x.md"), "# Hi\n\ntext".into());
        let backend = TestBackend::new(30, 4);
        let mut t = Terminal::new(backend).unwrap();
        t.draw(|f| v.draw(f)).unwrap();
        let buf = t.backend().buffer().clone();
        let row = |y: u16| -> String {
            (0..buf.area.width)
                .map(|x| buf[(x, y)].symbol().to_string())
                .collect::<String>()
        };
        assert_eq!(row(0).trim_end(), "Hi");
        assert_eq!(row(2).trim_end(), "text");
        assert!(row(3).contains("x.md"));
        assert!(row(3).contains("1-3/3"));
    }

    #[test]
    fn set_source_rerenders_and_keeps_scroll_in_range() {
        let mut v = Viewer::new(Path::new("/x.md"), doc(10));
        let backend = TestBackend::new(20, 5);
        let mut t = Terminal::new(backend).unwrap();
        t.draw(|f| v.draw(f)).unwrap();
        v.apply(Action::Bottom);
        v.set_source("short".into());
        t.draw(|f| v.draw(f)).unwrap();
        assert_eq!(v.scroll, 0);
    }
}
