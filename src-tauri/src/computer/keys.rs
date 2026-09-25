//! Keys an agent may press on a shared window, and which of them a window
//! grant allows.
//!
//! A window grant is permission to work *in* one window. A key reaches the
//! application, though, not the window: ⌘Q quits all of it, ⌘W closes the
//! window, and the platforms' own chords (⌘Tab, Alt+Tab, Win+L, ⌃⌘Q) act on
//! the whole desktop. So what a window grant lets through is a closed list —
//! the editing and navigation keys and the few chords that stay inside a text
//! field (select all, copy, cut, undo, redo, find, moving by word or line) —
//! and everything else is refused as needing more than one window.
//!
//! **Paste is its own case.** ⌘V writes the clipboard into a window the agent
//! can read, and the clipboard is the user's: what they last copied from a
//! password manager is exactly what would come back in the next snapshot. A
//! paste is safe only when the clipboard holds what the agent itself copied
//! out of a window it may read, which this version does not track — so every
//! paste chord is refused.
//!
//! The vocabulary is also closed, and spelled once here: the driver's key
//! names differ by platform (its Windows build even reads an unknown name as
//! its first letter — `printscreen` is P), so an agent's key is parsed into
//! [`Key`] and written back out in the one spelling that platform's driver
//! reads.

use serde::{Deserialize, Serialize};

/// A key on the keyboard, by what it is rather than by any platform's name
/// for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Key {
    /// A letter (`a`–`z`), a digit, or one of the punctuation keys of the
    /// main block. Always lowercase: the key, not the character shift makes
    /// of it.
    Char(char),
    Return,
    Tab,
    Space,
    /// Deletes to the left (the key a Mac labels "delete").
    Backspace,
    /// Deletes to the right (fn+delete on a Mac).
    Delete,
    Escape,
    Home,
    End,
    PageUp,
    PageDown,
    Up,
    Down,
    Left,
    Right,
    /// F1–F12.
    F(u8),
}

/// The punctuation keys of the main block, as their unshifted characters.
const PUNCTUATION: &[char] = &['-', '=', '[', ']', '\\', ';', '\'', ',', '.', '/', '`'];

impl Key {
    /// Parse an agent's name for a key. Case does not matter; a few common
    /// aliases are read (`enter`, `esc`, `del`, `arrowup`, …).
    pub fn parse(name: &str) -> Result<Key, String> {
        let raw = name.trim();
        if raw.chars().count() == 1 {
            let c = raw.chars().next().unwrap_or(' ');
            let lower = c.to_ascii_lowercase();
            return if lower.is_ascii_lowercase() || lower.is_ascii_digit() {
                Ok(Key::Char(lower))
            } else if PUNCTUATION.contains(&c) {
                Ok(Key::Char(c))
            } else if c == ' ' {
                Ok(Key::Space)
            } else {
                Err(format!(
                    "`{raw}` is not a key this tool presses; type text with computer_type"
                ))
            };
        }
        let lower = raw.to_ascii_lowercase().replace(['-', ' '], "_");
        let key = match lower.as_str() {
            "return" | "enter" => Key::Return,
            "tab" => Key::Tab,
            "space" | "spacebar" => Key::Space,
            "backspace" => Key::Backspace,
            "delete" | "del" | "forward_delete" | "forwarddelete" => Key::Delete,
            "escape" | "esc" => Key::Escape,
            "home" => Key::Home,
            "end" => Key::End,
            "pageup" | "page_up" | "pgup" => Key::PageUp,
            "pagedown" | "page_down" | "pgdn" => Key::PageDown,
            "up" | "arrowup" | "up_arrow" | "arrow_up" => Key::Up,
            "down" | "arrowdown" | "down_arrow" | "arrow_down" => Key::Down,
            "left" | "arrowleft" | "left_arrow" | "arrow_left" => Key::Left,
            "right" | "arrowright" | "right_arrow" | "arrow_right" => Key::Right,
            other => match other.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()) {
                Some(n) if (1..=12).contains(&n) => Key::F(n),
                _ => {
                    return Err(format!(
                        "`{raw}` is not a key this tool knows. Keys: a letter, a digit or a \
                         punctuation key, return, tab, space, backspace, delete, escape, home, \
                         end, pageup, pagedown, up, down, left, right, f1–f12"
                    ))
                }
            },
        };
        Ok(key)
    }

    /// Whether pressing it (with nothing held, or shift) puts a character
    /// into whatever has focus.
    pub fn is_character(self) -> bool {
        matches!(self, Key::Char(_) | Key::Space)
    }

    /// The key's name as `platform`'s driver reads it.
    pub fn driver_name(self, platform: Platform) -> String {
        match self {
            Key::Char(c) => c.to_string(),
            Key::Return => "return".into(),
            Key::Tab => "tab".into(),
            Key::Space => "space".into(),
            Key::Backspace => "backspace".into(),
            // The Mac driver's "delete" is the Mac key of that name, which
            // deletes to the left.
            Key::Delete => match platform {
                Platform::Mac => "forward_delete".into(),
                Platform::Windows | Platform::Linux => "delete".into(),
            },
            Key::Escape => "escape".into(),
            Key::Home => "home".into(),
            Key::End => "end".into(),
            Key::PageUp => "pageup".into(),
            Key::PageDown => "pagedown".into(),
            Key::Up => "up".into(),
            Key::Down => "down".into(),
            Key::Left => "left".into(),
            Key::Right => "right".into(),
            Key::F(n) => format!("f{n}"),
        }
    }

    fn is_arrow(self) -> bool {
        matches!(self, Key::Up | Key::Down | Key::Left | Key::Right)
    }
}

/// The modifier keys held with a key.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Modifiers {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub shift: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub control: bool,
    /// Option on a Mac.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub alt: bool,
    /// Command on a Mac; the Windows key, or Super, elsewhere.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub meta: bool,
}

impl Modifiers {
    /// Parse an agent's list of modifier names.
    pub fn parse<S: AsRef<str>>(names: &[S]) -> Result<Modifiers, String> {
        let mut m = Modifiers::default();
        for name in names {
            match name.as_ref().trim().to_ascii_lowercase().as_str() {
                "shift" => m.shift = true,
                "control" | "ctrl" => m.control = true,
                "alt" | "option" | "opt" => m.alt = true,
                "meta" | "command" | "cmd" | "super" | "win" | "windows" => m.meta = true,
                other => {
                    return Err(format!(
                        "`{other}` is not a modifier. Modifiers: shift, control, alt (option), \
                         meta (command on a Mac)"
                    ))
                }
            }
        }
        Ok(m)
    }

    pub fn is_empty(self) -> bool {
        self == Modifiers::default()
    }

    /// The modifiers as `platform`'s driver spells them.
    pub fn driver_names(self, platform: Platform) -> Vec<&'static str> {
        let mut out = Vec::new();
        if self.shift {
            out.push("shift");
        }
        if self.control {
            out.push("ctrl");
        }
        if self.alt {
            out.push(match platform {
                Platform::Mac => "option",
                Platform::Windows | Platform::Linux => "alt",
            });
        }
        if self.meta {
            out.push(match platform {
                Platform::Mac => "cmd",
                Platform::Windows => "win",
                Platform::Linux => "super",
            });
        }
        out
    }
}

/// A key and the modifiers held with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chord {
    pub key: Key,
    #[serde(default)]
    pub modifiers: Modifiers,
}

impl Chord {
    /// Whether the chord types a character into whatever has focus: a
    /// character key with nothing held but, perhaps, shift. Such a key goes
    /// only into an element the agent names, and never into a secret one.
    pub fn types_text(&self) -> bool {
        let m = self.modifiers;
        self.key.is_character() && !m.control && !m.alt && !m.meta
    }
}

/// Which desktop the rules are being applied for. The chords differ — the
/// shortcut modifier is ⌘ on a Mac and Ctrl elsewhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Mac,
    Windows,
    Linux,
}

impl Platform {
    pub fn current() -> Platform {
        if cfg!(target_os = "macos") {
            Platform::Mac
        } else if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Linux
        }
    }
}

/// What a window grant makes of a chord.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChordClass {
    /// Stays inside the window: editing and navigation.
    Window,
    /// Writes the clipboard into the window. See the module note.
    Paste,
    /// Acts on the application or the desktop — or is simply not on the
    /// list. Needs more than a window grant.
    Beyond,
}

/// Judge `chord` for a window grant on `platform`. See the module note.
pub fn classify(chord: &Chord, platform: Platform) -> ChordClass {
    let Chord { key, modifiers: m } = *chord;
    // The platform's shortcut modifier, and the one that is not it. On
    // Windows and Linux the Windows / Super key is the desktop's own and
    // never reaches a single window.
    let (primary, other) = match platform {
        Platform::Mac => (m.meta, m.control),
        Platform::Windows | Platform::Linux => (m.control, m.meta),
    };
    if other {
        return ChordClass::Beyond;
    }
    if primary && key == Key::Char('v') {
        return ChordClass::Paste;
    }
    match (primary, m.alt) {
        // Nothing held but perhaps shift: every key but the function keys,
        // which applications (and some desktops) bind to their own commands,
        // and shift+delete, which deletes a selected file for good in the
        // Windows File Explorer.
        (false, false) => {
            if matches!(key, Key::F(_)) || (m.shift && key == Key::Delete) {
                ChordClass::Beyond
            } else {
                ChordClass::Window
            }
        }
        // The shortcut modifier: the editing chords, and moving through text.
        // Shift only where it is the same command backwards (redo, find
        // previous) or extends a selection — ⇧⌘A opens a folder in the
        // Finder, and ⇧⌘⌫ empties the Trash. ⌘ with backspace or delete is a
        // menu command on a Mac (the Finder's Move to Trash), so only Ctrl
        // deletes by word elsewhere.
        (true, false) => {
            let editing = match key {
                Key::Char('a' | 'c' | 'x' | 'f') => !m.shift,
                Key::Char('z' | 'g') => true,
                Key::Char('y') => platform != Platform::Mac && !m.shift,
                _ => false,
            };
            let moving = key.is_arrow()
                || (platform != Platform::Mac
                    && (matches!(key, Key::Home | Key::End)
                        || (matches!(key, Key::Backspace | Key::Delete) && !m.shift)));
            if editing || moving {
                ChordClass::Window
            } else {
                ChordClass::Beyond
            }
        }
        // Option on a Mac moves and deletes by word; Alt elsewhere opens the
        // application's menus.
        (false, true) => {
            let by_word = key.is_arrow()
                || (matches!(key, Key::Backspace | Key::Delete) && !m.shift);
            if platform == Platform::Mac && by_word {
                ChordClass::Window
            } else {
                ChordClass::Beyond
            }
        }
        (true, true) => ChordClass::Beyond,
    }
}

/// The chords a window grant allows, in words, for a refusal to quote.
pub fn window_chords_note(platform: Platform) -> &'static str {
    match platform {
        Platform::Mac => {
            "On a shared window you may press the editing and navigation keys (return, tab, \
             escape, backspace, delete, the arrows, home, end, page up/down — with or without \
             shift, except shift+delete) and ⌘A, ⌘C, ⌘X, ⌘Z, ⇧⌘Z, ⌘F, ⌘G, ⇧⌘G, ⌘ or ⌥ with \
             an arrow (with or without shift), ⌥ with backspace or delete."
        }
        Platform::Windows | Platform::Linux => {
            "On a shared window you may press the editing and navigation keys (enter, tab, \
             escape, backspace, delete, the arrows, home, end, page up/down — with or without \
             shift, except shift+delete) and Ctrl+A, Ctrl+C, Ctrl+X, Ctrl+Z, Ctrl+Shift+Z, \
             Ctrl+Y, Ctrl+F, Ctrl+G, Ctrl with an arrow, home or end (with or without shift), \
             Ctrl with backspace or delete."
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chord(key: &str, modifiers: &[&str]) -> Chord {
        Chord {
            key: Key::parse(key).unwrap(),
            modifiers: Modifiers::parse(modifiers).unwrap(),
        }
    }

    /// Names are read case-insensitively with their common aliases, and a
    /// name that is no key is refused rather than guessed at — the Windows
    /// driver would press its first letter.
    #[test]
    fn keys_parse_into_one_closed_vocabulary() {
        assert_eq!(Key::parse("Enter"), Ok(Key::Return));
        assert_eq!(Key::parse("ESC"), Ok(Key::Escape));
        assert_eq!(Key::parse("ArrowUp"), Ok(Key::Up));
        assert_eq!(Key::parse("page down"), Ok(Key::PageDown));
        assert_eq!(Key::parse("A"), Ok(Key::Char('a')));
        assert_eq!(Key::parse("7"), Ok(Key::Char('7')));
        assert_eq!(Key::parse("/"), Ok(Key::Char('/')));
        assert_eq!(Key::parse("F12"), Ok(Key::F(12)));
        for bad in ["printscreen", "f13", "f0", "é", "!", "volumeup", "", "cmd"] {
            assert!(Key::parse(bad).is_err(), "{bad}");
        }
        assert!(Modifiers::parse(&["hyper"]).is_err());
        assert_eq!(
            Modifiers::parse(&["Command", "option"]).unwrap(),
            Modifiers {
                meta: true,
                alt: true,
                ..Modifiers::default()
            }
        );
    }

    /// Each platform's driver gets its own spelling — the one that differs
    /// being "delete", which the Mac driver reads as backspace.
    #[test]
    fn keys_are_written_in_each_drivers_spelling() {
        assert_eq!(Key::Delete.driver_name(Platform::Mac), "forward_delete");
        assert_eq!(Key::Delete.driver_name(Platform::Windows), "delete");
        assert_eq!(Key::Backspace.driver_name(Platform::Mac), "backspace");
        let all = Modifiers {
            shift: true,
            control: true,
            alt: true,
            meta: true,
        };
        assert_eq!(
            all.driver_names(Platform::Mac),
            vec!["shift", "ctrl", "option", "cmd"]
        );
        assert_eq!(
            all.driver_names(Platform::Windows),
            vec!["shift", "ctrl", "alt", "win"]
        );
        assert_eq!(
            all.driver_names(Platform::Linux),
            vec!["shift", "ctrl", "alt", "super"]
        );
    }

    /// The editing and navigation chords stay in the window; paste is told
    /// apart; the application's and the desktop's chords are refused.
    #[test]
    fn a_window_grant_allows_editing_and_navigation_only() {
        let mac = Platform::Mac;
        for ok in [
            chord("return", &[]),
            chord("tab", &["shift"]),
            chord("left", &["shift"]),
            chord("a", &[]),
            chord("a", &["cmd"]),
            chord("c", &["cmd"]),
            chord("z", &["cmd", "shift"]),
            chord("g", &["cmd", "shift"]),
            chord("left", &["cmd", "shift"]),
            chord("backspace", &["option"]),
            chord("right", &["option", "shift"]),
            chord("delete", &[]),
        ] {
            assert_eq!(classify(&ok, mac), ChordClass::Window, "{ok:?}");
        }
        for paste in [
            chord("v", &["cmd"]),
            chord("v", &["cmd", "shift"]),
            chord("v", &["cmd", "shift", "option"]),
        ] {
            assert_eq!(classify(&paste, mac), ChordClass::Paste, "{paste:?}");
        }
        for beyond in [
            chord("q", &["cmd"]),
            chord("w", &["cmd"]),
            chord("tab", &["cmd"]),
            chord("space", &["cmd"]),
            chord("h", &["cmd"]),
            chord("q", &["cmd", "ctrl"]),
            chord("q", &["cmd", "shift"]),
            chord("escape", &["cmd", "option"]),
            chord("a", &["ctrl"]),
            chord("e", &["option"]),
            chord("f11", &[]),
            chord("y", &["cmd"]),
            // ⇧⌘A opens a Finder folder; ⇧⌘⌫ empties the Trash; ⌘⌫ moves a
            // file to it.
            chord("a", &["cmd", "shift"]),
            chord("backspace", &["cmd", "shift"]),
            chord("backspace", &["option", "shift"]),
            chord("backspace", &["cmd"]),
            chord("delete", &["cmd"]),
        ] {
            assert_eq!(classify(&beyond, mac), ChordClass::Beyond, "{beyond:?}");
        }

        let win = Platform::Windows;
        assert_eq!(classify(&chord("c", &["ctrl"]), win), ChordClass::Window);
        assert_eq!(
            classify(&chord("backspace", &["ctrl"]), win),
            ChordClass::Window
        );
        // Deletes a selected file for good in the File Explorer.
        assert_eq!(
            classify(&chord("delete", &["shift"]), win),
            ChordClass::Beyond
        );
        assert_eq!(classify(&chord("y", &["ctrl"]), win), ChordClass::Window);
        assert_eq!(
            classify(&chord("home", &["ctrl", "shift"]), win),
            ChordClass::Window
        );
        assert_eq!(classify(&chord("v", &["ctrl"]), win), ChordClass::Paste);
        for beyond in [
            chord("f4", &["alt"]),
            chord("tab", &["alt"]),
            chord("l", &["win"]),
            chord("r", &["win"]),
            chord("delete", &["ctrl", "alt"]),
            chord("c", &["cmd"]),
            chord("w", &["ctrl"]),
            chord("f", &["alt"]),
        ] {
            assert_eq!(classify(&beyond, win), ChordClass::Beyond, "{beyond:?}");
        }
    }

    /// Only a bare or shifted character key types text; a chord with the
    /// shortcut modifier does not.
    #[test]
    fn only_character_keys_type_text() {
        assert!(chord("a", &[]).types_text());
        assert!(chord("a", &["shift"]).types_text());
        assert!(chord("space", &[]).types_text());
        assert!(!chord("a", &["cmd"]).types_text());
        assert!(!chord("return", &[]).types_text());
        assert!(!chord("backspace", &[]).types_text());
    }
}
