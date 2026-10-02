# Spec Delta

## Purpose

Lets songwriters ask for several AI takes of one part of one track, audition each in place against the rest of the song, and keep the one they like. Selected bars can also be regenerated without touching anything else in the song.

## ADDED Requirements

### Requirement: Selecting bars on a track
The user SHALL be able to select a contiguous range of whole measures on one track's lane. The user does this by Shift-dragging across the lane, or by Shift-clicking a start measure and then an end measure. The selection SHALL be shown on that lane only.

Selecting a clip SHALL make the clip's measures available as a selection. A track's Generate action SHALL also offer the whole song as a selection.

Selection limits:
- A selection SHALL span at most 32 measures.
- A selection SHALL NOT extend past measure 128.
- A selection MAY extend past the song's current end.

Pressing Escape, clicking elsewhere on the timeline, or selecting another track SHALL clear the selection. The selection SHALL NOT be saved with the song, and SHALL NOT be an undo step.

#### Scenario: Select bars
- **WHEN** the user Shift-drags across measures 5–8 of the Keys lane
- **THEN** measures 5–8 of the Keys lane are shown as selected, and no other lane shows a selection

#### Scenario: Selection is capped
- **WHEN** the user Shift-drags from measure 1 to measure 40
- **THEN** the selection stops at measure 32

#### Scenario: Escape clears the selection
- **WHEN** measures 5–8 are selected and the user presses Escape
- **THEN** no measures are selected

### Requirement: Regenerate selected bars
While measures are selected on a track, the Studio SHALL offer "Regenerate bars". It SHALL open the track's Generate form (see `songs/track-generation`, "Generate a track in the Studio") with the custom range set to the selection. When the user last generated this track in this session, the prompt SHALL be pre-filled with that prompt; otherwise the prompt SHALL be empty.

The result SHALL be applied by the same rules as any track generation: only the selected measures of that track change, and the change is one undo step.

#### Scenario: Only the selected bars change
- **WHEN** the Keys track has clips over measures 1–12, the user selects measures 5–8, and the user chooses "Regenerate bars"
- **THEN** after the result is applied, measures 1–4 and 9–12 of the Keys track play exactly as before, and every other track is unchanged

#### Scenario: Prompt is remembered
- **WHEN** the user generated the Keys track with "soft arpeggios", then selects measures 5–8 and chooses "Regenerate bars"
- **THEN** the form opens with "soft arpeggios" in the prompt and measures 5–8 as the range

### Requirement: Requesting takes
While measures are selected on a track, or a clip is selected, the Studio SHALL offer "Takes…". This SHALL open a form with:
- a prompt field, with the same token counter and over-limit behavior as the Generate form, pre-filled by the same rule as "Regenerate bars";
- a take count from 2 to 6, which defaults to 4;
- a note giving the number of AI requests the takes will use.

The range SHALL be the selected measures, or the selected clip's measures. "Takes…" SHALL NOT be offered for an audio track, because track generation does not apply to audio tracks.

On submit, the Studio SHALL start a variation session. It SHALL send one track-generation request per take, each with `take` `{index, count}` (see `songs/track-generation`, "Alternative takes") and with the same song, track, prompt, and range. At most 2 requests SHALL be in flight at a time.

#### Scenario: Default of four takes
- **WHEN** the user selects measures 9–16 of the Bass track, opens "Takes…", and submits a prompt without changing the count
- **THEN** four track-generation requests are sent for measures 9–16, with `take` indexes 1, 2, 3, and 4 and count 4

#### Scenario: Cost is shown
- **WHEN** the user sets the take count to 6
- **THEN** the form says that 6 AI requests will be used

#### Scenario: Clip as selection
- **WHEN** the user selects a clip covering measures 17–20 of the Keys track and chooses "Takes…"
- **THEN** the form's range is measures 17–20

### Requirement: Variation session
A variation session SHALL belong to one track and one range. While it is open:
- The Takes panel SHALL list "Original" and one entry per requested take. Each take's entry SHALL show whether it is pending, ready, or failed. When a take fails, the entry SHALL show the error message and a Retry action, and Retry SHALL send that take's request again.
- Takes SHALL become ready one at a time as their responses arrive. A take that fails, is rate-limited (`429`), or times out SHALL NOT cancel or discard the other takes.
- When a request is rate-limited, the take's entry SHALL say when it can be retried, using the `Retry-After` time.
- The target track's clips and loops SHALL NOT be editable. Track generation, song chat, structural section edits, tempo and meter changes, undo, and redo SHALL be refused, each with a message saying a takes session is open.
- Other tracks' notes and mixer, playback, and the loop region SHALL remain usable.

Only one variation session SHALL be open per song at a time, and a session SHALL NOT start while a track generation is in flight.

Closing the song, opening another song, or reloading the page SHALL end the session without changing the song.

#### Scenario: Takes arrive independently
- **WHEN** four takes are requested and the third request fails with `502`
- **THEN** takes 1, 2, and 4 become ready and can be auditioned, and take 3 shows the error with a Retry action

#### Scenario: Rate limited take
- **WHEN** the fourth take's request gets `429` with `Retry-After: 20`
- **THEN** takes 1–3 are usable, and take 4 says it can be retried in about 20 seconds

#### Scenario: Other tracks stay editable
- **WHEN** a variation session is open on the Bass track and the user changes the Drums volume
- **THEN** the volume changes

#### Scenario: Structural edits refused
- **WHEN** a variation session is open and the user tries to delete a section
- **THEN** the section is not deleted, and a message says a takes session is open

### Requirement: Auditioning takes
Choosing a ready take in the Takes panel SHALL make the arrangement show it, and playback play it, in the session's range on the target track. Inside that range, the track's existing clips SHALL be treated as replaced, by the same rules a generation result is applied with. Everything outside the range, and every other track, SHALL be shown and played exactly as in the song.

Choosing "Original" SHALL show and play the song unchanged.

Switching between the original and takes:
- Switching SHALL take effect without stopping playback, and the playhead SHALL keep its position.
- A Compare action, with the keyboard shortcut `C` when focus is not in a text field, SHALL switch between "Original" and the most recently chosen take.

When the session opens, playback SHALL loop over the session's range by default. When the session ends, the loop region and looping setting the song had before SHALL be restored.

Auditioning SHALL NOT change the saved song, SHALL NOT trigger a save, and SHALL NOT be an undo step.

#### Scenario: Audition in place
- **WHEN** take 2 for measures 9–16 of the Bass track is chosen and the song is played from measure 7
- **THEN** measures 7–8 play the song's existing bass, measures 9–16 play take 2's notes, and the drums play as in the song throughout

#### Scenario: A/B without stopping
- **WHEN** playback is at measure 11 playing take 2, and the user presses `C`
- **THEN** playback continues from measure 11, playing the original bass part

#### Scenario: Audition is not saved
- **WHEN** the user auditions take 3 and reloads the page without keeping it
- **THEN** the song opens without take 3's notes

### Requirement: Keeping and discarding takes
The Takes panel SHALL offer **Keep** for the chosen take. Keep SHALL write that take to the target track by the same rules as applying a track-generation result (see `songs/track-generation`, "Generate a track in the Studio"), and SHALL then end the session.

Each other ready take SHALL offer an "Also keep as spare loop" option. Every take marked this way SHALL be added to the track as a new loop that holds its notes and is not placed as a clip, named by the same "<track name> <n>" rule. These loops SHALL be listed in the track's loop menu and can be placed later with "Place loop".

Keep, together with any spare loops, SHALL be one undo step. When the kept take and spare loops together would exceed the track's loop or clip limit, nothing SHALL be applied, the session SHALL stay open, and the user SHALL be told how many spare loops fit.

**Discard** SHALL end the session and leave the song unchanged. Discarding SHALL NOT be an undo step.

#### Scenario: Keep one take
- **WHEN** the user keeps take 2 for measures 9–16 of the Bass track
- **THEN** the Bass track has a new loop holding take 2's notes, placed as one clip over measures 9–16, measures outside 9–16 are unchanged, and one Cmd/Ctrl+Z restores the track exactly as before

#### Scenario: Keep a spare
- **WHEN** the user marks take 4 as a spare and keeps take 1
- **THEN** take 1's loop is placed over the range, take 4's loop appears in the loop menu with 0 clips, and one Cmd/Ctrl+Z removes both

#### Scenario: Discard leaves the song unchanged
- **WHEN** the user requests four takes, auditions two, and discards the session
- **THEN** the song is identical to what it was before the takes were requested, and the loop region is restored
