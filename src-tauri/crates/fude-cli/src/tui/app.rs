//! The terminal editor: tabs of documents, an optional file tree, and a live
//! preview — the GUI's layout, driven by the GUI's key bindings mapped as
//! docs/TUI_DESIGN.md §6 describes (`Ctrl+Shift+X` becomes `Alt+X`).

use super::doc::Doc;
use super::list_continue::{continuation, Continuation};
use super::render::{self, Rendered};
use super::sidebar::Sidebar;
use crate::agent::Side;
use crate::watch::Watcher;
use edtui::{EditorMode, EditorTheme, EditorView, LineNumbers};
use ratatui::crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers, MouseEventKind};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Widget, Wrap};
use ratatui::Frame;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ViewMode {
    Editor,
    Split,
    Preview,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Focus {
    Editor,
    Sidebar,
}

/// A modal question or overlay. Keys go here first while one is open.
#[derive(Debug, Clone, PartialEq)]
pub enum Prompt {
    None,
    /// Close tab `idx` although it has unsaved changes?
    ConfirmClose(usize),
    ConfirmQuit,
    /// An autosave from an earlier session exists for the doc at `idx`.
    Recover {
        idx: usize,
        text: String,
    },
    Help,
}

const SIDEBAR_WIDTH: u16 = 28;

pub struct App {
    pub docs: Vec<Doc>,
    pub active: usize,
    pub view: ViewMode,
    pub focus: Focus,
    pub sidebar: Sidebar,
    pub vim: bool,
    pub prompt: Prompt,
    pub quit: bool,
    status: String,
    status_at: Instant,
    preview: Rendered,
    preview_key: (u64, u16),
    pub preview_scroll: usize,
    preview_follow: bool,
    watcher: Option<Watcher>,
    watch_rx: mpsc::Receiver<PathBuf>,
}

fn hash_text(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

#[cfg(test)]
pub fn key(code: KeyCode, mods: KeyModifiers) -> Event {
    Event::Key(KeyEvent::new(code, mods))
}

impl App {
    pub fn new(vim: bool) -> App {
        let (tx, rx) = mpsc::channel();
        let watcher = Watcher::new(tx).ok();
        App {
            docs: Vec::new(),
            active: 0,
            view: ViewMode::Split,
            focus: Focus::Editor,
            sidebar: Sidebar::default(),
            vim,
            prompt: Prompt::None,
            quit: false,
            status: String::new(),
            status_at: Instant::now(),
            preview: Rendered::default(),
            preview_key: (0, 0),
            preview_scroll: 0,
            preview_follow: true,
            watcher,
            watch_rx: rx,
        }
    }

    pub fn set_status(&mut self, msg: impl Into<String>) {
        self.status = msg.into();
        self.status_at = Instant::now();
    }

    pub fn doc(&self) -> Option<&Doc> {
        self.docs.get(self.active)
    }

    pub fn doc_mut(&mut self) -> Option<&mut Doc> {
        self.docs.get_mut(self.active)
    }

    // ─── Opening and closing ────────────────────────────────

    /// Open a file or a directory (which becomes the sidebar root).
    pub fn open_path(&mut self, path: &Path) -> Result<(), String> {
        if path.is_dir() {
            self.sidebar.open(path)?;
            self.focus = Focus::Sidebar;
            return Ok(());
        }
        if let Some(i) = self
            .docs
            .iter()
            .position(|d| d.path.as_deref() == Some(path))
        {
            self.active = i;
            return Ok(());
        }
        let doc = Doc::open(path, self.vim)?;
        if let Some(w) = self.watcher.as_mut() {
            let _ = w.watch(path);
        }
        self.docs.push(doc);
        self.active = self.docs.len() - 1;
        self.focus = Focus::Editor;
        if let Some(text) = Doc::recoverable(path) {
            self.prompt = Prompt::Recover {
                idx: self.active,
                text,
            };
        }
        if self.sidebar.root.is_none() {
            if let Some(parent) = path.parent() {
                let _ = self.sidebar.open(parent);
                self.sidebar.visible = false;
            }
        }
        self.sidebar.reveal(path);
        Ok(())
    }

    pub fn new_doc(&mut self) {
        self.docs.push(Doc::new(None, String::new(), self.vim));
        self.active = self.docs.len() - 1;
        self.focus = Focus::Editor;
    }

    /// Close tab `idx`, asking first when it has unsaved changes.
    pub fn close(&mut self, idx: usize, force: bool) {
        let Some(doc) = self.docs.get(idx) else {
            return;
        };
        if doc.dirty() && !force {
            self.prompt = Prompt::ConfirmClose(idx);
            return;
        }
        let mut doc = self.docs.remove(idx);
        if let Some(p) = &doc.path {
            if let Some(w) = self.watcher.as_mut() {
                let _ = w.unwatch(p);
            }
        }
        doc.discard_temp();
        if self.active >= self.docs.len() {
            self.active = self.docs.len().saturating_sub(1);
        }
    }

    pub fn save(&mut self) {
        let Some(idx) = self.docs.get(self.active).map(|_| self.active) else {
            return;
        };
        let (watcher, doc) = (&mut self.watcher, &mut self.docs[idx]);
        if doc.path.is_none() {
            self.set_status("no file name (use `fude-cli FILE` to pick one)");
            return;
        }
        let mut before = |p: &Path| {
            if let Some(w) = watcher.as_mut() {
                w.before_write(p);
            }
        };
        match doc.save(&mut before) {
            Ok(()) => {
                let name = doc.name();
                self.set_status(format!("saved {}", name));
            }
            Err(e) => self.set_status(e),
        }
    }

    pub fn request_quit(&mut self) {
        if self.docs.iter().any(|d| d.dirty()) {
            self.prompt = Prompt::ConfirmQuit;
        } else {
            self.quit = true;
        }
    }

    // ─── Background work ───────────────────────────────────

    /// Disk changes and autosaves; call every tick.
    pub fn tick(&mut self) {
        let mut changed: Vec<PathBuf> = Vec::new();
        while let Ok(p) = self.watch_rx.try_recv() {
            changed.push(p);
        }
        for p in changed {
            for d in self.docs.iter_mut() {
                let same = d
                    .path
                    .as_ref()
                    .map(|dp| dp.canonicalize().unwrap_or(dp.clone()) == p)
                    .unwrap_or(false);
                if same {
                    d.on_disk_changed();
                    if d.disk_changed {
                        self.status = format!(
                            "{} changed on disk (Alt+R reloads, discarding edits)",
                            d.name()
                        );
                        self.status_at = Instant::now();
                    }
                }
            }
        }
        for d in self.docs.iter_mut() {
            d.autosave_if_due();
        }
    }

    // ─── Keys ───────────────────────────────────────────────

    pub fn handle(&mut self, ev: &Event) {
        match ev {
            Event::Key(k) if k.is_press() => self.handle_key(*k),
            Event::Mouse(m) => match m.kind {
                MouseEventKind::ScrollDown => self.scroll_preview(3),
                MouseEventKind::ScrollUp => self.scroll_preview(-3),
                _ => {}
            },
            Event::Paste(text) => {
                if let Some(d) = self.doc_mut() {
                    d.handler.on_paste_event(text.clone(), &mut d.state);
                    d.note_change();
                }
            }
            _ => {}
        }
    }

    fn handle_key(&mut self, k: KeyEvent) {
        if self.prompt != Prompt::None {
            self.handle_prompt_key(k);
            return;
        }
        let alt = k.modifiers.contains(KeyModifiers::ALT);
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        // App-level bindings (GUI's Ctrl+Shift+X → Alt+X).
        match (k.code, alt, ctrl) {
            (KeyCode::Char('q'), true, _) | (KeyCode::Char('q'), _, true) => {
                return self.request_quit()
            }
            (KeyCode::Char('s'), _, true) => return self.save(),
            (KeyCode::Char('j'), true, _) => return self.set_view(ViewMode::Editor),
            (KeyCode::Char('k'), true, _) => return self.set_view(ViewMode::Split),
            (KeyCode::Char('l'), true, _) => return self.set_view(ViewMode::Preview),
            (KeyCode::Char('e'), true, _) => return self.toggle_sidebar(),
            (KeyCode::Char('w'), true, _) => return self.close(self.active, false),
            (KeyCode::Char('t'), true, _) | (KeyCode::Char('n'), true, _) => return self.new_doc(),
            (KeyCode::Char(']'), true, _) => return self.cycle(1),
            (KeyCode::Char('['), true, _) => return self.cycle(-1),
            (KeyCode::Char('r'), true, _) => return self.reload(),
            (KeyCode::F(1), _, _) | (KeyCode::Char('?'), true, _) => {
                self.prompt = Prompt::Help;
                return;
            }
            _ => {}
        }
        match self.focus {
            Focus::Sidebar => self.handle_sidebar_key(k),
            Focus::Editor => {
                if self.view == ViewMode::Preview {
                    self.handle_preview_key(k);
                } else {
                    self.handle_editor_key(k);
                }
            }
        }
    }

    fn handle_prompt_key(&mut self, k: KeyEvent) {
        let yes = matches!(
            k.code,
            KeyCode::Char('y') | KeyCode::Char('Y') | KeyCode::Enter
        );
        let no = matches!(
            k.code,
            KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc
        );
        match self.prompt.clone() {
            Prompt::None => {}
            Prompt::Help => self.prompt = Prompt::None,
            Prompt::ConfirmClose(idx) => {
                if yes {
                    self.prompt = Prompt::None;
                    self.close(idx, true);
                } else if no {
                    self.prompt = Prompt::None;
                }
            }
            Prompt::ConfirmQuit => {
                if yes {
                    self.quit = true;
                } else if no {
                    self.prompt = Prompt::None;
                }
            }
            Prompt::Recover { idx, text } => {
                if yes {
                    if let Some(d) = self.docs.get_mut(idx) {
                        let saved = d.text();
                        d.set_text(&text);
                        // set_text marks the text as "on disk"; restore the
                        // real disk text so the recovered buffer counts as dirty.
                        d.mark_disk_text(&saved);
                        d.note_change();
                    }
                    self.prompt = Prompt::None;
                    self.set_status("recovered unsaved edits (Ctrl+S to keep them)");
                } else if no {
                    if let Some(d) = self.docs.get_mut(idx) {
                        d.discard_temp();
                    }
                    self.prompt = Prompt::None;
                }
            }
        }
    }

    fn handle_sidebar_key(&mut self, k: KeyEvent) {
        match k.code {
            KeyCode::Char('j') | KeyCode::Down => self.sidebar.move_by(1),
            KeyCode::Char('k') | KeyCode::Up => self.sidebar.move_by(-1),
            KeyCode::Char('g') | KeyCode::Home => self.sidebar.move_by(-(i32::MAX / 2)),
            KeyCode::Char('G') | KeyCode::End => self.sidebar.move_by(i32::MAX / 2),
            KeyCode::Enter | KeyCode::Char('l') | KeyCode::Right => {
                if let Some(p) = self.sidebar.activate() {
                    if let Err(e) = self.open_path(&p) {
                        self.set_status(e);
                    }
                }
            }
            KeyCode::Char('h') | KeyCode::Left => {
                if self
                    .sidebar
                    .rows
                    .get(self.sidebar.selected)
                    .map(|r| r.is_dir && r.expanded)
                    == Some(true)
                {
                    self.sidebar.activate();
                }
            }
            KeyCode::Esc | KeyCode::Tab | KeyCode::Char('q') => {
                if !self.docs.is_empty() {
                    self.focus = Focus::Editor;
                }
            }
            KeyCode::Char('r') => self.sidebar.refresh(),
            _ => {}
        }
    }

    fn handle_preview_key(&mut self, k: KeyEvent) {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        match (k.code, ctrl) {
            (KeyCode::Char('j'), false) | (KeyCode::Down, _) => self.scroll_preview(1),
            (KeyCode::Char('k'), false) | (KeyCode::Up, _) => self.scroll_preview(-1),
            (KeyCode::Char('d'), true) | (KeyCode::PageDown, _) | (KeyCode::Char(' '), false) => {
                self.scroll_preview(10)
            }
            (KeyCode::Char('u'), true) | (KeyCode::PageUp, _) => self.scroll_preview(-10),
            (KeyCode::Char('g'), false) | (KeyCode::Home, _) => {
                self.preview_scroll = 0;
                self.preview_follow = false;
            }
            (KeyCode::Char('G'), false) | (KeyCode::End, _) => {
                self.preview_scroll = usize::MAX / 2;
                self.preview_follow = false;
            }
            (KeyCode::Tab, _) => {
                if self.sidebar.visible {
                    self.focus = Focus::Sidebar;
                }
            }
            _ => {}
        }
    }

    fn handle_editor_key(&mut self, k: KeyEvent) {
        let Some(doc) = self.docs.get_mut(self.active) else {
            // Nothing open: only the sidebar can be used.
            if self.sidebar.visible {
                self.focus = Focus::Sidebar;
            }
            return;
        };
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let insert = doc.state.mode == EditorMode::Insert;
        match (k.code, ctrl) {
            // Normal key mode never leaves insert mode: Esc is a no-op there.
            (KeyCode::Esc, _) if insert && !self.vim => return,
            (KeyCode::Char('f'), true) => {
                doc.state.mode = EditorMode::Search;
                return;
            }
            (KeyCode::Char('z'), true) if insert => {
                doc.state.undo();
                doc.note_change();
                return;
            }
            (KeyCode::Char('y'), true) if insert => {
                doc.state.redo();
                doc.note_change();
                return;
            }
            (KeyCode::Tab, _) if self.sidebar.visible && !insert => {
                self.focus = Focus::Sidebar;
                return;
            }
            (KeyCode::Enter, false) if insert => {
                let line = doc.current_line();
                let at_end = doc.state.cursor.col >= line.chars().count();
                if at_end {
                    match continuation(&line) {
                        Continuation::Plain => {}
                        Continuation::Marker(m) => {
                            doc.handler.on_key_event(k, &mut doc.state);
                            for ch in m.chars() {
                                let e = KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE);
                                doc.handler.on_key_event(e, &mut doc.state);
                            }
                            doc.note_change();
                            self.preview_follow = true;
                            return;
                        }
                        Continuation::EndList { chars } => {
                            for _ in 0..chars {
                                let e = KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE);
                                doc.handler.on_key_event(e, &mut doc.state);
                            }
                            doc.handler.on_key_event(k, &mut doc.state);
                            doc.note_change();
                            self.preview_follow = true;
                            return;
                        }
                    }
                }
            }
            _ => {}
        }
        let before = doc.state.cursor;
        doc.handler.on_key_event(k, &mut doc.state);
        doc.note_change();
        if doc.state.cursor != before {
            self.preview_follow = true;
        }
    }

    fn set_view(&mut self, v: ViewMode) {
        self.view = v;
        if v != ViewMode::Preview && self.focus == Focus::Editor {
            self.preview_follow = true;
        }
    }

    fn toggle_sidebar(&mut self) {
        if self.sidebar.root.is_none() {
            self.set_status("no folder open (start with `fude-cli DIR`)");
            return;
        }
        if self.focus == Focus::Sidebar {
            self.sidebar.visible = false;
            self.focus = Focus::Editor;
        } else {
            self.sidebar.visible = true;
            self.focus = Focus::Sidebar;
        }
    }

    fn cycle(&mut self, delta: i32) {
        if self.docs.is_empty() {
            return;
        }
        let n = self.docs.len() as i32;
        self.active = ((self.active as i32 + delta).rem_euclid(n)) as usize;
        self.preview_follow = true;
    }

    fn reload(&mut self) {
        if let Some(d) = self.doc_mut() {
            match d.reload_from_disk() {
                Ok(()) => self.set_status("reloaded from disk"),
                Err(e) => self.set_status(e),
            }
        }
    }

    fn scroll_preview(&mut self, delta: i32) {
        self.preview_follow = false;
        self.preview_scroll = if delta < 0 {
            self.preview_scroll.saturating_sub((-delta) as usize)
        } else {
            self.preview_scroll + delta as usize
        };
    }

    // ─── Drawing ────────────────────────────────────────────

    pub fn draw(&mut self, frame: &mut Frame) {
        let area = frame.area();
        let (side, main) = if self.sidebar.visible {
            let [s, m] =
                Layout::horizontal([Constraint::Length(SIDEBAR_WIDTH), Constraint::Min(10)])
                    .areas(area);
            (Some(s), m)
        } else {
            (None, area)
        };
        let [tabs, body, bar] = Layout::vertical([
            Constraint::Length(1),
            Constraint::Min(1),
            Constraint::Length(1),
        ])
        .areas(main);

        if let Some(s) = side {
            self.draw_sidebar(frame, s);
        }
        self.draw_tabs(frame, tabs);
        match self.view {
            ViewMode::Editor => self.draw_editor(frame, body),
            ViewMode::Preview => self.draw_preview(frame, body),
            ViewMode::Split => {
                let [l, r] =
                    Layout::horizontal([Constraint::Percentage(50), Constraint::Percentage(50)])
                        .areas(body);
                self.draw_editor(frame, l);
                self.draw_preview(frame, r);
            }
        }
        self.draw_status(frame, bar);
        self.draw_prompt(frame, area);
    }

    fn draw_sidebar(&mut self, frame: &mut Frame, area: Rect) {
        let focused = self.focus == Focus::Sidebar;
        let title = self
            .sidebar
            .root
            .as_ref()
            .and_then(|r| r.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let block = Block::default()
            .borders(Borders::RIGHT)
            .title(Span::styled(
                format!(" FILES {}", title),
                Style::default()
                    .fg(Color::DarkGray)
                    .add_modifier(Modifier::BOLD),
            ))
            .border_style(Style::default().fg(Color::DarkGray));
        let inner = block.inner(area);
        block.render(area, frame.buffer_mut());
        let height = inner.height.max(1) as usize;
        let top = self.sidebar.selected.saturating_sub(height - 1);
        let open: Vec<PathBuf> = self.docs.iter().filter_map(|d| d.path.clone()).collect();
        let lines: Vec<Line> = self
            .sidebar
            .rows
            .iter()
            .enumerate()
            .skip(top)
            .take(height)
            .map(|(i, r)| {
                let icon = if r.is_dir {
                    if r.expanded {
                        "▾ "
                    } else {
                        "▸ "
                    }
                } else {
                    "  "
                };
                let text = format!("{}{}{}", " ".repeat(r.depth * 2), icon, r.name);
                let mut style = Style::default();
                if r.is_dir {
                    style = style.fg(Color::Blue);
                }
                if open.iter().any(|p| p == &r.path) {
                    style = style.add_modifier(Modifier::BOLD);
                }
                if i == self.sidebar.selected && focused {
                    style = style.bg(Color::DarkGray).fg(Color::White);
                } else if i == self.sidebar.selected {
                    style = style.add_modifier(Modifier::UNDERLINED);
                }
                Line::from(Span::styled(text, style))
            })
            .collect();
        Paragraph::new(lines).render(inner, frame.buffer_mut());
    }

    fn draw_tabs(&self, frame: &mut Frame, area: Rect) {
        let mut spans = Vec::new();
        for (i, d) in self.docs.iter().enumerate() {
            let label = format!(" {}{} ", d.name(), if d.dirty() { "*" } else { "" });
            let style = if i == self.active {
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD | Modifier::REVERSED)
            } else {
                Style::default().fg(Color::DarkGray)
            };
            spans.push(Span::styled(label, style));
            spans.push(Span::raw(" "));
        }
        if self.docs.is_empty() {
            spans.push(Span::styled(
                " (no file open — Enter in the file list, or Alt+T for a new one) ",
                Style::default().fg(Color::DarkGray),
            ));
        }
        Paragraph::new(Line::from(spans)).render(area, frame.buffer_mut());
    }

    fn draw_editor(&mut self, frame: &mut Frame, area: Rect) {
        let Some(doc) = self.docs.get_mut(self.active) else {
            Paragraph::new("").render(area, frame.buffer_mut());
            return;
        };
        doc.state.set_viewport_height(area.height as usize);
        let theme = EditorTheme::default()
            .base(Style::default())
            .cursor_style(Style::default().add_modifier(Modifier::REVERSED))
            .selection_style(Style::default().bg(Color::DarkGray))
            .line_numbers_style(Style::default().fg(Color::DarkGray))
            .hide_status_line();
        EditorView::new(&mut doc.state)
            .theme(theme)
            .line_numbers(LineNumbers::Absolute)
            .wrap(true)
            .render(area, frame.buffer_mut());
    }

    fn draw_preview(&mut self, frame: &mut Frame, area: Rect) {
        let block = Block::default()
            .borders(if self.view == ViewMode::Split {
                Borders::LEFT
            } else {
                Borders::NONE
            })
            .border_style(Style::default().fg(Color::DarkGray));
        let inner = block.inner(area);
        block.render(area, frame.buffer_mut());
        let Some(doc) = self.docs.get(self.active) else {
            return;
        };
        let text = doc.text();
        let width = inner.width.saturating_sub(1).max(4);
        let key = (hash_text(&text), width);
        if key != self.preview_key {
            self.preview = render::render(&text, width);
            self.preview_key = key;
        }
        let page = inner.height.max(1) as usize;
        let total = self.preview.lines.len();
        if self.preview_follow && self.view != ViewMode::Preview {
            let target = self.preview.line_for_source(doc.state.cursor.row + 1);
            self.preview_scroll = target.saturating_sub(page / 3);
        }
        self.preview_scroll = self.preview_scroll.min(total.saturating_sub(page));
        let lines: Vec<Line<'static>> = self
            .preview
            .lines
            .iter()
            .skip(self.preview_scroll)
            .take(page)
            .map(|l| l.line.clone())
            .collect();
        Paragraph::new(lines).render(
            Rect {
                x: inner.x + 1,
                width: inner.width.saturating_sub(1),
                ..inner
            },
            frame.buffer_mut(),
        );
    }

    fn draw_status(&self, frame: &mut Frame, area: Rect) {
        let style = Style::default().bg(Color::DarkGray).fg(Color::White);
        let left = match self.doc() {
            Some(d) => {
                let mode = match d.state.mode {
                    EditorMode::Normal => "NORMAL",
                    EditorMode::Insert => {
                        if self.vim {
                            "INSERT"
                        } else {
                            "EDIT"
                        }
                    }
                    EditorMode::Visual => "VISUAL",
                    EditorMode::Search => "SEARCH",
                };
                let path = d
                    .path
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| "Untitled".into());
                // Mode and position first: a long path must not push them
                // off a narrow terminal.
                format!(
                    " {}  Ln {}, Col {}  {}  {}{}",
                    mode,
                    d.state.cursor.row + 1,
                    d.state.cursor.col + 1,
                    match self.view {
                        ViewMode::Editor => "editor",
                        ViewMode::Split => "split",
                        ViewMode::Preview => "preview",
                    },
                    path,
                    if d.dirty() { " *" } else { "" },
                )
            }
            None => " Fude".to_string(),
        };
        let right = if !self.status.is_empty() && self.status_at.elapsed() < Duration::from_secs(8)
        {
            format!("{}  ", self.status)
        } else {
            "F1 help ".to_string()
        };
        let pad =
            (area.width as usize).saturating_sub(left.chars().count() + right.chars().count());
        Paragraph::new(Line::from(vec![
            Span::styled(left, style.add_modifier(Modifier::BOLD)),
            Span::styled(" ".repeat(pad), style),
            Span::styled(right, style),
        ]))
        .style(style)
        .render(area, frame.buffer_mut());
    }

    fn draw_prompt(&self, frame: &mut Frame, area: Rect) {
        let (title, body): (&str, String) = match &self.prompt {
            Prompt::None => return,
            Prompt::ConfirmClose(idx) => (
                " Close? ",
                format!(
                    "\"{}\" has unsaved changes. Close anyway?  [y/N]",
                    self.docs.get(*idx).map(|d| d.name()).unwrap_or_default()
                ),
            ),
            Prompt::ConfirmQuit => (
                " Quit? ",
                "There are unsaved changes. Quit anyway?  [y/N]".into(),
            ),
            Prompt::Recover { idx, .. } => (
                " Recover? ",
                format!(
                    "An autosaved draft of \"{}\" exists. Restore it?  [y/N]",
                    self.docs.get(*idx).map(|d| d.name()).unwrap_or_default()
                ),
            ),
            Prompt::Help => (" Keys ", HELP.into()),
        };
        let lines = body.lines().count() as u16 + 2;
        let width = (area.width.saturating_sub(4)).clamp(20, 64);
        let height = lines.min(area.height.saturating_sub(2)).max(3);
        let rect = Rect {
            x: area.x + (area.width.saturating_sub(width)) / 2,
            y: area.y + (area.height.saturating_sub(height)) / 2,
            width,
            height,
        };
        Clear.render(rect, frame.buffer_mut());
        Paragraph::new(body)
            .wrap(Wrap { trim: false })
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(title)
                    .border_style(Style::default().fg(Color::Yellow)),
            )
            .render(rect, frame.buffer_mut());
    }
}

const HELP: &str = "\
Ctrl+S save   Alt+W close tab   Alt+T new tab   Alt+] / Alt+[ next/prev tab
Alt+J editor  Alt+K split  Alt+L preview      Alt+E file list (Tab: back)
Ctrl+F search  Alt+R reload from disk          Alt+Q / Ctrl+Q quit
Edit mode: Ctrl+Z undo  Ctrl+Y redo  Enter continues lists
Vim mode (key_mode=vim in config): i/Esc, u, Ctrl+R, /, v …
Preview: j/k, Ctrl+D/U, g/G scroll           any key closes this";

/// Run the editor on `paths` (files and/or one directory). Returns the exit code.
pub fn run(paths: &[String]) -> i32 {
    let vim = fude_core::load_config()
        .map(|c| c.effective_key_mode() == "vim")
        .unwrap_or(false);
    let mut app = App::new(vim);
    for p in paths {
        if let Err(e) = app.open_path(Path::new(p)) {
            eprintln!("fude-cli: {}", e);
            return 2;
        }
    }
    if app.docs.is_empty() && app.sidebar.root.is_none() {
        app.new_doc();
    }

    let mut terminal = match ratatui::try_init() {
        Ok(t) => t,
        Err(e) => {
            eprintln!("fude-cli: cannot start the terminal UI: {}", e);
            return 2;
        }
    };
    let _ = ratatui::crossterm::execute!(
        std::io::stdout(),
        event::EnableMouseCapture,
        event::EnableBracketedPaste
    );

    let code = loop {
        if terminal.draw(|f| app.draw(f)).is_err() {
            break 2;
        }
        match event::poll(Duration::from_millis(100)) {
            Ok(true) => match event::read() {
                Ok(ev) => app.handle(&ev),
                Err(_) => break 2,
            },
            Ok(false) => {}
            Err(_) => break 2,
        }
        app.tick();
        if app.quit {
            break 0;
        }
    };
    let _ = ratatui::crossterm::execute!(
        std::io::stdout(),
        event::DisableBracketedPaste,
        event::DisableMouseCapture
    );
    ratatui::restore();
    code
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    use tempfile::TempDir;

    fn k(code: KeyCode, mods: KeyModifiers) -> Event {
        key(code, mods)
    }

    fn typed(app: &mut App, s: &str) {
        for ch in s.chars() {
            app.handle(&k(KeyCode::Char(ch), KeyModifiers::NONE));
        }
    }

    fn rows(t: &Terminal<TestBackend>) -> Vec<String> {
        let buf = t.backend().buffer();
        (0..buf.area.height)
            .map(|y| {
                (0..buf.area.width)
                    .map(|x| buf[(x, y)].symbol().to_string())
                    .collect::<String>()
                    .trim_end()
                    .to_string()
            })
            .collect()
    }

    #[test]
    fn opens_a_file_edits_it_and_saves_with_ctrl_s() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("a.md");
        std::fs::write(&p, "# Title\n\n- item\n").unwrap();
        let mut app = App::new(false);
        app.open_path(&p).unwrap();
        assert_eq!(app.docs.len(), 1);
        assert!(app.sidebar.root.is_some());
        assert!(!app.sidebar.visible);

        let mut t = Terminal::new(TestBackend::new(80, 12)).unwrap();
        t.draw(|f| app.draw(f)).unwrap();
        let screen = rows(&t).join("\n");
        assert!(screen.contains("a.md"));
        assert!(screen.contains("# Title"));
        assert!(screen.contains("Title")); // preview too
        assert!(screen.contains("EDIT"));

        typed(&mut app, "X");
        assert!(app.doc().unwrap().dirty());
        app.handle(&k(KeyCode::Char('s'), KeyModifiers::CONTROL));
        assert!(!app.doc().unwrap().dirty());
        assert!(std::fs::read_to_string(&p).unwrap().starts_with("X# Title"));
    }

    #[test]
    fn enter_continues_lists_and_ends_empty_items() {
        let mut app = App::new(false);
        app.new_doc();
        typed(&mut app, "- one");
        app.handle(&k(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(app.doc().unwrap().text(), "- one\n- ");
        app.handle(&k(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(app.doc().unwrap().text(), "- one\n\n");
        typed(&mut app, "1. x");
        app.handle(&k(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(app.doc().unwrap().text(), "- one\n\n1. x\n2. ");
    }

    #[test]
    fn view_modes_tabs_and_quit_confirmation() {
        let mut app = App::new(false);
        app.new_doc();
        app.new_doc();
        assert_eq!(app.active, 1);
        app.handle(&k(KeyCode::Char('['), KeyModifiers::ALT));
        assert_eq!(app.active, 0);
        app.handle(&k(KeyCode::Char(']'), KeyModifiers::ALT));
        assert_eq!(app.active, 1);
        app.handle(&k(KeyCode::Char('j'), KeyModifiers::ALT));
        assert_eq!(app.view, ViewMode::Editor);
        app.handle(&k(KeyCode::Char('l'), KeyModifiers::ALT));
        assert_eq!(app.view, ViewMode::Preview);
        app.handle(&k(KeyCode::Char('k'), KeyModifiers::ALT));
        assert_eq!(app.view, ViewMode::Split);

        typed(&mut app, "dirty");
        app.handle(&k(KeyCode::Char('q'), KeyModifiers::ALT));
        assert_eq!(app.prompt, Prompt::ConfirmQuit);
        assert!(!app.quit);
        app.handle(&k(KeyCode::Char('n'), KeyModifiers::NONE));
        assert_eq!(app.prompt, Prompt::None);
        app.handle(&k(KeyCode::Char('w'), KeyModifiers::ALT));
        assert_eq!(app.prompt, Prompt::ConfirmClose(1));
        app.handle(&k(KeyCode::Char('y'), KeyModifiers::NONE));
        assert_eq!(app.docs.len(), 1);
        app.handle(&k(KeyCode::Char('q'), KeyModifiers::CONTROL));
        assert!(app.quit);
    }

    #[test]
    fn a_directory_opens_the_sidebar_and_enter_opens_files() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("n.md"), "note").unwrap();
        let mut app = App::new(false);
        app.open_path(tmp.path()).unwrap();
        assert_eq!(app.focus, Focus::Sidebar);
        assert!(app.sidebar.visible);
        let mut t = Terminal::new(TestBackend::new(80, 10)).unwrap();
        t.draw(|f| app.draw(f)).unwrap();
        assert!(rows(&t).join("\n").contains("n.md"));
        app.handle(&k(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(app.docs.len(), 1);
        assert_eq!(app.focus, Focus::Editor);
        assert_eq!(app.doc().unwrap().text(), "note");
        // Alt+E hides the list when it has focus, shows + focuses it otherwise.
        app.handle(&k(KeyCode::Char('e'), KeyModifiers::ALT));
        assert_eq!(app.focus, Focus::Sidebar);
        app.handle(&k(KeyCode::Char('e'), KeyModifiers::ALT));
        assert!(!app.sidebar.visible);
        assert_eq!(app.focus, Focus::Editor);
    }

    #[test]
    fn esc_keeps_edit_mode_unless_vim_and_help_overlay_closes() {
        let mut app = App::new(false);
        app.new_doc();
        app.handle(&k(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(app.doc().unwrap().state.mode, EditorMode::Insert);
        app.handle(&k(KeyCode::F(1), KeyModifiers::NONE));
        assert_eq!(app.prompt, Prompt::Help);
        app.handle(&k(KeyCode::Char('x'), KeyModifiers::NONE));
        assert_eq!(app.prompt, Prompt::None);

        let mut vim = App::new(true);
        vim.new_doc();
        assert_eq!(vim.doc().unwrap().state.mode, EditorMode::Normal);
        typed(&mut vim, "i");
        assert_eq!(vim.doc().unwrap().state.mode, EditorMode::Insert);
        vim.handle(&k(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(vim.doc().unwrap().state.mode, EditorMode::Normal);
    }

    #[test]
    fn recovery_prompt_restores_the_autosaved_draft() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("r.md");
        std::fs::write(&p, "disk").unwrap();
        fude_core::write_temp_file(&p.to_string_lossy(), "draft").unwrap();
        let mut app = App::new(false);
        app.open_path(&p).unwrap();
        assert!(matches!(app.prompt, Prompt::Recover { .. }));
        app.handle(&k(KeyCode::Char('y'), KeyModifiers::NONE));
        assert_eq!(app.doc().unwrap().text(), "draft");
        assert!(app.doc().unwrap().dirty());
        fude_core::delete_temp_file(&p.to_string_lossy()).unwrap();
    }
}
