# Spec Delta

## MODIFIED Requirements

### Requirement: Context token budget
The context SHALL be limited by an estimated token budget, `max_context_tokens`, which is taken from service configuration and defaults to 4000. The estimate SHALL use the same rule as the prompt token limit, applied to the rendered context text.

When the full context would exceed the budget, the system SHALL trim it in this order:
1. Drop context measures in order of distance from the range, farthest first.
2. If the context still exceeds the budget, drop other tracks' measures inside the range, starting from the last track in song order.

When a song chat request names an anchor track (see "Anchor track in song chat"), the anchor's measures SHALL be trimmed only after every other track's measures have been dropped. Within the anchor, measures SHALL be dropped farthest from the range first.

Context size SHALL never cause a request to be rejected.

#### Scenario: Large song trimmed, not rejected
- **WHEN** a 16-track song with dense notes is sent with `range` `{1, 32}` and the budget is 4000
- **THEN** the request is not rejected, and the context sent to the provider is estimated at no more than 4000 tokens

#### Scenario: Budget respected by configuration
- **WHEN** the service is configured with a context budget of 500 and a request's full context would be estimated at 2000 tokens
- **THEN** the context sent is estimated at no more than 500 tokens

#### Scenario: Anchor kept longest
- **WHEN** a song chat request names the last track in song order as its anchor, and the budget only allows one track's in-range measures
- **THEN** the context sent holds the anchor's in-range measures and none of the other tracks' measures

## ADDED Requirements

### Requirement: Anchor track in song chat
The song chat endpoint SHALL accept an optional `anchor_track_id`, the id of a note track (not an audio track) in the song. A request whose `anchor_track_id` names no such track SHALL be rejected with `400` and error code `invalid_track`, and no provider SHALL be called.

When an anchor is given, the following rules SHALL apply:
- **Range:** when the message names no length, the chat range SHALL be the anchor's clip span, from the first measure of its earliest clip to the last measure of its latest-ending clip, provided that span is at most 32 measures. Otherwise, the usual chat range rules SHALL apply.
- **Context:** the anchor's notes SHALL be included in the context even when the anchor is muted, and SHALL be identified to the provider as the idea the new part is built around.
- **Trimming:** the anchor SHALL be trimmed last (see "Context token budget").

A request without `anchor_track_id` SHALL behave exactly as before this requirement.

#### Scenario: Range follows the anchor
- **WHEN** a client posts a 32-measure song whose anchor track has clips covering measures 9–16, with the message "add drums around this"
- **THEN** the response's `track.range` is `{9, 16}`

#### Scenario: Named length wins
- **WHEN** the anchor covers measures 9–16 and the message is "give me 4 bars of bass"
- **THEN** the response's `track.range` is `{1, 4}`

#### Scenario: Muted anchor still heard
- **WHEN** the anchor track is muted
- **THEN** the provider context still contains the anchor's notes, marked as the anchor

#### Scenario: Unknown anchor
- **WHEN** `anchor_track_id` names an audio track or no track
- **THEN** the response is `400` with error code `invalid_track`, and no provider is called

#### Scenario: No anchor, unchanged
- **WHEN** a chat request has no `anchor_track_id`
- **THEN** its range, context, and trimming are the same as before this requirement
