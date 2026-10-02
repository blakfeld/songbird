//! Pulls the planner's `reply` text out of its JSON while the JSON is still being written, so
//! the chat can show the reply before the plan is complete. Only the top-level `reply` string
//! is read, and the final validated result stays the authority on what the reply is.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StringRole {
    Key,
    Reply,
    /// Any other string, including every string inside a nested value, which must be skipped
    /// without being mistaken for a key.
    Ignored,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Escape {
    None,
    Backslash,
    Unicode { digits: u8, value: u32 },
}

#[derive(Debug)]
pub struct ReplyExtractor {
    depth: usize,
    expecting_key: bool,
    key: String,
    string: Option<StringRole>,
    escape: Escape,
    /// A high surrogate waits here until its low half arrives, possibly in a later fragment,
    /// because neither half is a character on its own.
    high_surrogate: Option<u32>,
    done: bool,
}

impl Default for ReplyExtractor {
    fn default() -> Self {
        Self::new()
    }
}

impl ReplyExtractor {
    pub fn new() -> Self {
        Self {
            depth: 0,
            expecting_key: false,
            key: String::new(),
            string: None,
            escape: Escape::None,
            high_surrogate: None,
            done: false,
        }
    }

    /// Fragments arrive at arbitrary byte-sized boundaries, so only text that can no longer
    /// change is returned: a pending surrogate half or partial escape waits for the next call.
    pub fn push(&mut self, fragment: &str) -> String {
        let mut out = String::new();
        for c in fragment.chars() {
            match self.string {
                Some(role) => self.string_char(role, c, &mut out),
                None => self.structural_char(c),
            }
        }
        out
    }

    fn structural_char(&mut self, c: char) {
        match c {
            '{' => {
                self.depth += 1;
                if self.depth == 1 {
                    self.expecting_key = true;
                }
            }
            '[' => self.depth += 1,
            '}' | ']' => self.depth = self.depth.saturating_sub(1),
            ',' if self.depth == 1 => self.expecting_key = true,
            ':' if self.depth == 1 => self.expecting_key = false,
            '"' => {
                let role = if self.depth != 1 || self.done {
                    StringRole::Ignored
                } else if self.expecting_key {
                    self.key.clear();
                    StringRole::Key
                } else if self.key == "reply" {
                    StringRole::Reply
                } else {
                    StringRole::Ignored
                };
                self.string = Some(role);
                self.escape = Escape::None;
                self.high_surrogate = None;
            }
            _ => {}
        }
    }

    fn string_char(&mut self, role: StringRole, c: char, out: &mut String) {
        match self.escape {
            Escape::None => match c {
                '\\' => self.escape = Escape::Backslash,
                '"' => self.end_string(role, out),
                other => self.emit(role, other, out),
            },
            Escape::Backslash => {
                self.escape = Escape::None;
                match c {
                    'u' => {
                        self.escape = Escape::Unicode {
                            digits: 0,
                            value: 0,
                        }
                    }
                    'n' => self.emit(role, '\n', out),
                    't' => self.emit(role, '\t', out),
                    'r' => self.emit(role, '\r', out),
                    'b' => self.emit(role, '\u{8}', out),
                    'f' => self.emit(role, '\u{c}', out),
                    // `"`, `\` and `/` stand for themselves; anything else is invalid JSON, and
                    // keeping the character is the most forgiving reading.
                    other => self.emit(role, other, out),
                }
            }
            Escape::Unicode { digits, value } => {
                let Some(nibble) = c.to_digit(16) else {
                    self.escape = Escape::None;
                    self.emit(role, char::REPLACEMENT_CHARACTER, out);
                    // The character is not part of the escape, and may be the closing quote;
                    // swallowing it would keep the string open and leak the fields after it.
                    self.string_char(role, c, out);
                    return;
                };
                let value = value * 16 + nibble;
                if digits + 1 < 4 {
                    self.escape = Escape::Unicode {
                        digits: digits + 1,
                        value,
                    };
                } else {
                    self.escape = Escape::None;
                    self.code_unit(role, value, out);
                }
            }
        }
    }

    fn code_unit(&mut self, role: StringRole, unit: u32, out: &mut String) {
        match unit {
            0xD800..=0xDBFF => {
                self.flush_lone_surrogate(role, out);
                self.high_surrogate = Some(unit);
            }
            0xDC00..=0xDFFF => match self.high_surrogate.take() {
                Some(high) => {
                    let combined = 0x10000 + ((high - 0xD800) << 10) + (unit - 0xDC00);
                    let c = char::from_u32(combined).unwrap_or(char::REPLACEMENT_CHARACTER);
                    self.push_char(role, c, out);
                }
                None => self.push_char(role, char::REPLACEMENT_CHARACTER, out),
            },
            _ => {
                let c = char::from_u32(unit).unwrap_or(char::REPLACEMENT_CHARACTER);
                self.emit(role, c, out);
            }
        }
    }

    fn flush_lone_surrogate(&mut self, role: StringRole, out: &mut String) {
        if self.high_surrogate.take().is_some() {
            self.push_char(role, char::REPLACEMENT_CHARACTER, out);
        }
    }

    fn emit(&mut self, role: StringRole, c: char, out: &mut String) {
        self.flush_lone_surrogate(role, out);
        self.push_char(role, c, out);
    }

    fn push_char(&mut self, role: StringRole, c: char, out: &mut String) {
        match role {
            StringRole::Key => self.key.push(c),
            StringRole::Reply => out.push(c),
            StringRole::Ignored => {}
        }
    }

    fn end_string(&mut self, role: StringRole, out: &mut String) {
        self.flush_lone_surrogate(role, out);
        self.string = None;
        if role == StringRole::Reply {
            // A repeated `reply` key would otherwise append a second text to the first.
            self.done = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Fixtures spell a JSON unicode escape as `@u`, so the escapes under test are explicit
    /// without the source file containing them.
    fn json(template: &str) -> String {
        template.replace("@u", "\\u")
    }

    fn extract_in_pieces(json: &str, boundaries: &[usize]) -> String {
        let mut extractor = ReplyExtractor::new();
        let mut out = String::new();
        let mut from = 0;
        for &to in boundaries.iter().chain(std::iter::once(&json.len())) {
            out.push_str(&extractor.push(&json[from..to]));
            from = to;
        }
        out
    }

    fn extract_whole(json: &str) -> String {
        ReplyExtractor::new().push(json)
    }

    fn parsed_reply(json: &str) -> Option<String> {
        let value: Value = serde_json::from_str(json).ok()?;
        value["reply"].as_str().map(str::to_string)
    }

    fn fixtures() -> Vec<String> {
        [
            r#"{"action":"reply_only","reply":"Hello there.","instrument":"piano"}"#,
            r#"{"action":"add_track","reply":"Line one\nline \"two\" \\ \/ \t@u00e9","instrument":"bass","prompt":"p","measures":null}"#,
            r#"{ "action" : "add_track" , "reply" : "spaced" , "measures" : 4 }"#,
            r#"{"reply":"drums @ud83e@udd41 and @u00e9 @u2603 plus raw 🥁"}"#,
            r#"{"meta":{"reply":"nested, not this one"},"reply":"top level"}"#,
            r#"{"prompt":"reply","list":["reply",{"reply":"deep"}],"reply":"after"}"#,
            r#"{"action":"reply_only","instrument":"x","reply":""}"#,
            r#"{"re@u0070ly":"escaped key","action":"a"}"#,
            r#"{"reply":"a \"quoted, {braced} [bracketed]\" tail","x":"y"}"#,
        ]
        .iter()
        .map(|t| json(t))
        .collect()
    }

    #[test]
    fn fixtures_yield_exactly_the_parsed_reply() {
        for fixture in fixtures() {
            let expected = parsed_reply(&fixture).unwrap_or_else(|| panic!("{fixture}"));
            assert_eq!(extract_whole(&fixture), expected, "{fixture}");
        }
    }

    #[test]
    fn only_the_top_level_reply_is_read() {
        assert_eq!(
            extract_whole(r#"{"meta":{"reply":"nested"},"reply":"top"}"#),
            "top"
        );
        assert_eq!(extract_whole(r#"{"meta":{"reply":"nested"}}"#), "");
        assert_eq!(extract_whole(r#"{"prompt":"reply","x":"y"}"#), "");
        assert_eq!(extract_whole(r#"{"list":["reply"],"other":"v"}"#), "");
        assert_eq!(extract_whole(r#"["reply","x"]"#), "");
        assert_eq!(extract_whole(r#"{"replyx":"no","xreply":"no"}"#), "");
    }

    #[test]
    fn an_invalid_unicode_escape_does_not_swallow_the_closing_quote() {
        assert_eq!(
            extract_whole(&json(r#"{"reply":"a@u12","prompt":"leak"}"#)),
            "a\u{fffd}"
        );
        assert_eq!(
            extract_whole(&json(r#"{"reply":"a@uzz b","prompt":"leak"}"#)),
            "a\u{fffd}zz b"
        );
    }

    #[test]
    fn a_repeated_reply_key_does_not_append_a_second_text() {
        // The parsed draft keeps the last value, so `plan_chat` resets the stream when the
        // first one was not a prefix of it; here only the no-append rule is pinned.
        assert_eq!(extract_whole(r#"{"reply":"one","reply":"two"}"#), "one");
    }

    #[test]
    fn escapes_and_surrogate_pairs_decode() {
        assert_eq!(
            extract_whole(&json(
                r#"{"reply":"a\nb\t\"c\"\\ @u00e9 @ud83e@udd41 @u2603"}"#
            )),
            "a\nb\t\"c\"\\ \u{e9} \u{1f941} \u{2603}"
        );
    }

    #[test]
    fn a_surrogate_pair_split_across_fragments_is_emitted_whole() {
        let mut extractor = ReplyExtractor::new();
        assert_eq!(extractor.push(&json(r#"{"reply":"x@ud83e"#)), "x");
        assert_eq!(extractor.push(&json("@udd")), "");
        assert_eq!(extractor.push(r#"41y""#), "\u{1f941}y");
    }

    #[test]
    fn every_fixture_split_at_every_offset_yields_the_same_text() {
        for fixture in fixtures() {
            let expected = parsed_reply(&fixture).unwrap();
            for offset in (0..=fixture.len()).filter(|i| fixture.is_char_boundary(*i)) {
                assert_eq!(
                    extract_in_pieces(&fixture, &[offset]),
                    expected,
                    "{fixture} @ {offset}"
                );
            }
            let every_char: Vec<usize> = fixture.char_indices().map(|(i, _)| i).skip(1).collect();
            assert_eq!(
                extract_in_pieces(&fixture, &every_char),
                expected,
                "{fixture}"
            );
        }
    }

    #[test]
    fn text_emitted_so_far_is_always_a_prefix_of_the_parsed_reply() {
        for fixture in fixtures() {
            let expected = parsed_reply(&fixture).unwrap();
            let mut extractor = ReplyExtractor::new();
            let mut seen = String::new();
            for (i, c) in fixture.char_indices() {
                seen.push_str(&extractor.push(&fixture[i..i + c.len_utf8()]));
                assert!(expected.starts_with(&seen), "{fixture}: {seen:?}");
            }
            assert_eq!(seen, expected);
        }
    }

    #[test]
    fn a_reply_streams_before_the_rest_of_the_object_is_written() {
        let mut extractor = ReplyExtractor::new();
        assert_eq!(
            extractor.push(r#"{"action":"add_track","reply":"Add"#),
            "Add"
        );
        assert_eq!(extractor.push(r#"ing a "#), "ing a ");
    }
}
