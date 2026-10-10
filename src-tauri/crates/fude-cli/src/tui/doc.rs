//! One open document: the edtui editor state plus what the app needs to
//! know about it (path, what is on disk, autosave).

use edtui::{EditorEventHandler, EditorMode, EditorState, Index2, Lines};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Autosave to the temp file this long after the last edit (GUI: 2s).
pub const AUTOSAVE_DELAY: Duration = Duration::from_secs(2);

pub struct Doc {
    pub path: Option<PathBuf>,
    pub state: EditorState,
    pub handler: EditorEventHandler,
    /// The text as last read from or written to disk.
    saved: String,
    /// When the text last changed (for the autosave debounce).
    changed_at: Option<Instant>,
    /// Whether a temp file may exist for this doc (written at least once).
    temp_written: bool,
    /// The file changed on disk while we had unsaved edits.
    pub disk_changed: bool,
}

/// Text of an edtui buffer.
pub fn text_of(state: &EditorState) -> String {
    state.lines.flatten(&Some('\n')).into_iter().collect()
}

impl Doc {
    pub fn new(path: Option<PathBuf>, text: String, vim: bool) -> Doc {
        let mut state = EditorState::new(Lines::from(text.as_str()));
        state.mode = if vim {
            EditorMode::Normal
        } else {
            EditorMode::Insert
        };
        Doc {
            path,
            state,
            handler: EditorEventHandler::vim_mode(),
            saved: text,
            changed_at: None,
            temp_written: false,
            disk_changed: false,
        }
    }

    pub fn open(path: &Path, vim: bool) -> Result<Doc, String> {
        let text = fude_core::read_file(&path.to_string_lossy())?;
        Ok(Doc::new(Some(path.to_path_buf()), text, vim))
    }

    pub fn name(&self) -> String {
        self.path
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "Untitled".into())
    }

    pub fn text(&self) -> String {
        text_of(&self.state)
    }

    pub fn dirty(&self) -> bool {
        self.text() != self.saved
    }

    /// Call after every key the editor handled.
    pub fn note_change(&mut self) {
        self.changed_at = Some(Instant::now());
    }

    /// The current line's text (for list continuation etc.).
    pub fn current_line(&self) -> String {
        let row = self.state.cursor.row;
        let n = self.state.lines.len_col(row).unwrap_or(0);
        (0..n)
            .filter_map(|c| self.state.lines.get(Index2::new(row, c)).copied())
            .collect()
    }

    /// Replace the whole text (reload), keeping the cursor in range.
    pub fn set_text(&mut self, text: &str) {
        let cursor = self.state.cursor;
        self.state.lines = Lines::from(text);
        let rows = self.state.lines.len().max(1);
        let row = cursor.row.min(rows - 1);
        let col = cursor.col.min(self.state.lines.len_col(row).unwrap_or(0));
        self.state.cursor = Index2::new(row, col);
        self.saved = text.to_string();
        self.disk_changed = false;
    }

    /// Record `text` as what is on disk without touching the buffer (after
    /// restoring an autosaved draft, the buffer must count as dirty).
    pub fn mark_disk_text(&mut self, text: &str) {
        self.saved = text.to_string();
    }

    /// Write to `path` (or the doc's own path).
    pub fn save(&mut self, before_write: &mut dyn FnMut(&Path)) -> Result<(), String> {
        let path = self.path.clone().ok_or("no file name")?;
        let text = self.text();
        before_write(&path);
        fude_core::write_file(&path.to_string_lossy(), &text)?;
        self.saved = text;
        self.disk_changed = false;
        self.discard_temp();
        Ok(())
    }

    /// Autosave the unsaved text to the temp file once the debounce elapsed.
    /// Returns true when a temp file was written.
    pub fn autosave_if_due(&mut self) -> bool {
        let Some(t) = self.changed_at else {
            return false;
        };
        if t.elapsed() < AUTOSAVE_DELAY {
            return false;
        }
        self.changed_at = None;
        let Some(path) = &self.path else { return false };
        if !self.dirty() {
            return false;
        }
        if fude_core::write_temp_file(&path.to_string_lossy(), &self.text()).is_ok() {
            self.temp_written = true;
            return true;
        }
        false
    }

    /// Remove the temp file (after a save or a deliberate close).
    pub fn discard_temp(&mut self) {
        if let Some(p) = &self.path {
            let _ = fude_core::delete_temp_file(&p.to_string_lossy());
        }
        self.temp_written = false;
    }

    /// The temp file left by an earlier session, if any.
    pub fn recoverable(path: &Path) -> Option<String> {
        let info = fude_core::check_temp_files(vec![path.to_string_lossy().to_string()]).ok()?;
        let temp = info.first()?;
        std::fs::read_to_string(&temp.temp_path).ok()
    }

    /// The file on disk changed: reload when clean, else just flag it.
    pub fn on_disk_changed(&mut self) {
        if self.dirty() {
            self.disk_changed = true;
            return;
        }
        if let Some(p) = &self.path {
            if let Ok(text) = fude_core::read_file(&p.to_string_lossy()) {
                self.set_text(&text);
            }
        }
    }

    pub fn reload_from_disk(&mut self) -> Result<(), String> {
        let p = self.path.clone().ok_or("no file name")?;
        let text = fude_core::read_file(&p.to_string_lossy())?;
        self.set_text(&text);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn dirty_tracks_the_text_against_disk() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("a.md");
        std::fs::write(&p, "hello\nworld\n").unwrap();
        let mut d = Doc::open(&p, false).unwrap();
        assert!(!d.dirty());
        assert_eq!(d.state.mode, EditorMode::Insert);
        assert_eq!(d.current_line(), "hello");
        d.state.lines = Lines::from("hello!\nworld\n");
        assert!(d.dirty());
        let mut marked = Vec::new();
        d.save(&mut |p| marked.push(p.to_path_buf())).unwrap();
        assert!(!d.dirty());
        assert_eq!(marked, vec![p.clone()]);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "hello!\nworld\n");
    }

    #[test]
    fn disk_changes_reload_only_when_clean() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("a.md");
        std::fs::write(&p, "one\n").unwrap();
        let mut d = Doc::open(&p, true).unwrap();
        assert_eq!(d.state.mode, EditorMode::Normal);
        std::fs::write(&p, "two\n").unwrap();
        d.on_disk_changed();
        assert_eq!(d.text(), "two\n");
        assert!(!d.disk_changed);

        d.state.lines = Lines::from("edited\n");
        std::fs::write(&p, "three\n").unwrap();
        d.on_disk_changed();
        assert_eq!(d.text(), "edited\n");
        assert!(d.disk_changed);
        d.reload_from_disk().unwrap();
        assert_eq!(d.text(), "three\n");
        assert!(!d.disk_changed);
    }

    #[test]
    fn set_text_keeps_the_cursor_in_range() {
        let mut d = Doc::new(None, "a\nb\nc\n".into(), false);
        d.state.cursor = Index2::new(2, 0);
        d.set_text("x");
        assert_eq!(d.state.cursor, Index2::new(0, 0));
        assert_eq!(d.name(), "Untitled");
    }
}
