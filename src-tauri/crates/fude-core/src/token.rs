//! The shared secret a remote agent must present (`hello.token`).
//!
//! A TCP `RemoteForward` makes the GUI reachable from any user on the remote
//! machine; the token keeps strangers from opening tabs in it or taking over
//! requests for files another agent serves. The GUI creates it once in its
//! config dir; the user copies it to each remote (`~/.config/fude/gui-token`
//! or `$FUDE_GUI_TOKEN`).

use std::fs;
use std::path::Path;

pub const TOKEN_FILE: &str = "gui-token";
pub const TOKEN_ENV: &str = "FUDE_GUI_TOKEN";

/// Read the token file, creating a fresh random one if there is none.
pub fn load_or_create(path: &Path) -> Result<String, String> {
    if let Some(t) = read(path)? {
        return Ok(t);
    }
    let token = generate();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {}", dir.display(), e))?;
    }
    fs::write(path, format!("{}\n", token))
        .map_err(|e| format!("cannot write {}: {}", path.display(), e))?;
    let _ = crate::paths::set_file_permissions(path);
    Ok(token)
}

/// The token from the file, if present and non-empty.
pub fn read(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let s =
        fs::read_to_string(path).map_err(|e| format!("cannot read {}: {}", path.display(), e))?;
    let t = s.trim();
    Ok(if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    })
}

/// The token a client should present: `$FUDE_GUI_TOKEN`, else the file.
pub fn client_token(path: &Path) -> Option<String> {
    if let Ok(t) = std::env::var(TOKEN_ENV) {
        if !t.trim().is_empty() {
            return Some(t.trim().to_string());
        }
    }
    read(path).ok().flatten()
}

/// 32 random bytes as hex. Uses the OS entropy source where there is one,
/// else hashes what little uniqueness is at hand (time, pid, addresses).
pub fn generate() -> String {
    let mut bytes = [0u8; 32];
    if !fill_os_random(&mut bytes) {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut h = DefaultHasher::new();
        std::time::SystemTime::now().hash(&mut h);
        std::process::id().hash(&mut h);
        (&bytes as *const _ as usize).hash(&mut h);
        for chunk in bytes.chunks_mut(8) {
            h.write_u64(h.finish());
            let v = h.finish().to_le_bytes();
            chunk.copy_from_slice(&v[..chunk.len()]);
        }
    }
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(unix)]
fn fill_os_random(buf: &mut [u8]) -> bool {
    use std::io::Read;
    fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(buf))
        .is_ok()
}

#[cfg(not(unix))]
fn fill_os_random(_buf: &mut [u8]) -> bool {
    false
}

/// Constant-time-ish comparison is unnecessary here (the token is long and
/// random, and the channel is ssh); plain equality after trimming.
pub fn matches(expected: &str, presented: Option<&str>) -> bool {
    matches!(presented, Some(p) if p.trim() == expected.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn creates_once_and_reads_back_the_same_token() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("sub").join(TOKEN_FILE);
        let a = load_or_create(&p).unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        let b = load_or_create(&p).unwrap();
        assert_eq!(a, b);
        assert_eq!(read(&p).unwrap(), Some(a.clone()));
        assert_ne!(generate(), generate());
    }

    #[test]
    fn empty_file_counts_as_missing_and_env_wins() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join(TOKEN_FILE);
        fs::write(&p, "  \n").unwrap();
        assert_eq!(read(&p).unwrap(), None);
        fs::write(&p, "filetoken\n").unwrap();
        std::env::remove_var(TOKEN_ENV);
        assert_eq!(client_token(&p).as_deref(), Some("filetoken"));
        std::env::set_var(TOKEN_ENV, "envtoken");
        assert_eq!(client_token(&p).as_deref(), Some("envtoken"));
        std::env::remove_var(TOKEN_ENV);
    }

    #[test]
    fn matching_ignores_surrounding_whitespace_only() {
        assert!(matches("abc", Some("abc\n")));
        assert!(!matches("abc", Some("abd")));
        assert!(!matches("abc", None));
        assert!(!matches("abc", Some("")));
    }
}
