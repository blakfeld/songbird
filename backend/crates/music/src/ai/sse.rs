//! Provider streams are small and well-formed, so this implements only the parts of the
//! server-sent events format they use, rather than pulling in a crate for the rest.

/// `event` is `None` for providers that send only `data:` lines, such as OpenAI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

/// Works on bytes because a network chunk can end in the middle of a multi-byte character;
/// text is decoded only once a whole line is available.
#[derive(Debug, Default)]
pub struct SseParser {
    buffer: Vec<u8>,
    event: Option<String>,
    data: Option<String>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buffer.extend_from_slice(chunk);
        let mut events = Vec::new();
        let mut consumed = 0;
        while let Some((line_end, next)) = next_line(&self.buffer[consumed..]) {
            let line =
                String::from_utf8_lossy(&self.buffer[consumed..consumed + line_end]).into_owned();
            consumed += next;
            if let Some(event) = self.line(&line) {
                events.push(event);
            }
        }
        self.buffer.drain(..consumed);
        events
    }

    fn line(&mut self, line: &str) -> Option<SseEvent> {
        if line.is_empty() {
            let data = self.data.take();
            let event = self.event.take();
            return data.map(|data| SseEvent { event, data });
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "event" => self.event = Some(value.to_string()),
            "data" => match &mut self.data {
                Some(data) => {
                    data.push('\n');
                    data.push_str(value);
                }
                None => self.data = Some(value.to_string()),
            },
            _ => {}
        }
        None
    }
}

/// Returns the line's length and how far to advance. A trailing `\r` is left unconsumed
/// because the next chunk may begin with the `\n` of a `\r\n` pair.
fn next_line(bytes: &[u8]) -> Option<(usize, usize)> {
    let end = bytes.iter().position(|b| *b == b'\n' || *b == b'\r')?;
    if bytes[end] == b'\n' {
        return Some((end, end + 1));
    }
    match bytes.get(end + 1) {
        Some(b'\n') => Some((end, end + 2)),
        Some(_) => Some((end, end + 1)),
        None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_whole(input: &[u8]) -> Vec<SseEvent> {
        SseParser::new().push(input)
    }

    fn parse_split_at(input: &[u8], offset: usize) -> Vec<SseEvent> {
        let mut parser = SseParser::new();
        let mut events = parser.push(&input[..offset]);
        events.extend(parser.push(&input[offset..]));
        events
    }

    fn parse_bytewise(input: &[u8]) -> Vec<SseEvent> {
        let mut parser = SseParser::new();
        input.iter().flat_map(|b| parser.push(&[*b])).collect()
    }

    fn event(name: Option<&str>, data: &str) -> SseEvent {
        SseEvent {
            event: name.map(Into::into),
            data: data.into(),
        }
    }

    const CLAUDE_FIXTURE: &str = "event: message_start\ndata: {\"type\":\"message_start\"}\n\n\
        event: content_block_delta\ndata: {\"delta\":{\"partial_json\":\"{\\\"re\"}}\n\n\
        event: ping\ndata: {}\n\n";
    const OPENAI_FIXTURE: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"h\u{e9}llo \u{1f941}\"}}]}\n\ndata: [DONE]\n\n";
    const CRLF_FIXTURE: &str = "event: a\r\ndata: one\r\n\r\nevent: b\r\ndata: two\r\n\r\n";
    const CR_ONLY_FIXTURE: &str = "event: a\rdata: one\r\rdata: two\r\r\n";
    const MULTILINE_FIXTURE: &str = "data: first\ndata: second\ndata:\ndata: fourth\n\n";
    const COMMENT_FIXTURE: &str =
        ": keepalive\n\nevent: a\n: inline comment\ndata: x\n\n: tail\n\n";

    const FIXTURES: [&str; 6] = [
        CLAUDE_FIXTURE,
        OPENAI_FIXTURE,
        CRLF_FIXTURE,
        CR_ONLY_FIXTURE,
        MULTILINE_FIXTURE,
        COMMENT_FIXTURE,
    ];

    #[test]
    fn every_fixture_parses_identically_split_at_every_byte_offset() {
        for fixture in FIXTURES {
            let bytes = fixture.as_bytes();
            let whole = parse_whole(bytes);
            assert!(!whole.is_empty(), "{fixture:?}");
            for offset in 0..=bytes.len() {
                assert_eq!(
                    parse_split_at(bytes, offset),
                    whole,
                    "{fixture:?} @ {offset}"
                );
            }
            assert_eq!(parse_bytewise(bytes), whole, "{fixture:?} bytewise");
        }
    }

    #[test]
    fn named_events_carry_their_name_and_data() {
        assert_eq!(
            parse_whole(CLAUDE_FIXTURE.as_bytes())
                .iter()
                .map(|e| e.event.clone().unwrap())
                .collect::<Vec<_>>(),
            ["message_start", "content_block_delta", "ping"]
        );
    }

    #[test]
    fn data_only_events_have_no_name() {
        assert_eq!(
            parse_whole(OPENAI_FIXTURE.as_bytes())[1],
            event(None, "[DONE]")
        );
    }

    #[test]
    fn crlf_and_bare_cr_line_endings_are_accepted() {
        let expected = vec![event(Some("a"), "one"), event(Some("b"), "two")];
        assert_eq!(parse_whole(CRLF_FIXTURE.as_bytes()), expected);
        assert_eq!(
            parse_whole(CR_ONLY_FIXTURE.as_bytes()),
            vec![event(Some("a"), "one"), event(None, "two")]
        );
    }

    #[test]
    fn multiple_data_lines_are_joined_with_newlines() {
        assert_eq!(
            parse_whole(MULTILINE_FIXTURE.as_bytes()),
            vec![event(None, "first\nsecond\n\nfourth")]
        );
    }

    #[test]
    fn comments_never_produce_events_or_break_one() {
        assert_eq!(
            parse_whole(COMMENT_FIXTURE.as_bytes()),
            vec![event(Some("a"), "x")]
        );
    }

    #[test]
    fn multibyte_text_survives_a_split_inside_a_character() {
        let events = parse_split_at(
            OPENAI_FIXTURE.as_bytes(),
            OPENAI_FIXTURE.find('\u{e9}').unwrap() + 1,
        );
        assert!(events[0].data.contains("h\u{e9}llo \u{1f941}"));
    }

    #[test]
    fn an_event_without_a_blank_line_is_not_delivered() {
        assert!(parse_whole(b"data: partial\n").is_empty());
    }

    #[test]
    fn only_one_leading_space_is_stripped_from_a_value() {
        assert_eq!(
            parse_whole(b"data:  two spaces\n\ndata:none\n\n"),
            vec![event(None, " two spaces"), event(None, "none")]
        );
    }

    #[test]
    fn an_event_name_does_not_leak_into_the_next_event() {
        assert_eq!(
            parse_whole(b"event: a\ndata: 1\n\ndata: 2\n\n"),
            vec![event(Some("a"), "1"), event(None, "2")]
        );
    }
}
