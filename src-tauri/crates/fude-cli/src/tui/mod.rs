//! The terminal UI: an editor with tabs, file list and live preview
//! (docs/TUI_DESIGN.md §5). `render` turns Markdown into terminal lines for
//! the preview pane.

pub mod app;
pub mod doc;
pub mod list_continue;
pub mod render;
pub mod sidebar;

pub use app::run;
