use midly::num::{u4, u7};
use midly::{MetaMessage, MidiMessage, TrackEvent, TrackEventKind};

use crate::instruments::{Instrument, InstrumentKind};
use crate::midi::{conductor_track, meta, note_events, program_change, write_smf, MidiError};
use crate::song::{SamplerKind, TrackInstrument, ValidSong, ValidTrack};
use crate::timing::step_to_ticks;

const DRUM_CHANNEL: u8 = 9;
const CC_VOLUME: u8 = 7;
const CC_PAN: u8 = 10;
const CC_VOLUME_AT_UNITY: f64 = 100.0;

/// Drums own channel 10 (index 9) as General MIDI requires; melodic tracks take
/// the others in order. Sixteen melodic tracks leave one without a free
/// channel, so channels are reused from the start rather than failing: each
/// song track is still its own MIDI track, so a DAW import is unaffected.
pub fn assign_channels(kinds: &[InstrumentKind]) -> Vec<u4> {
    let melodic: Vec<u8> = (0..16).filter(|&c| c != DRUM_CHANNEL).collect();
    let mut next = 0;
    kinds
        .iter()
        .map(|kind| match kind {
            InstrumentKind::Drums => u4::new(DRUM_CHANNEL),
            InstrumentKind::Melodic => {
                let channel = melodic[next % melodic.len()];
                next += 1;
                u4::new(channel)
            }
        })
        .collect()
}

/// Pads are a drums-kind instrument for the editor, but exporting them on
/// channel 10 would make a DAW play its drum kit instead of the user's samples.
fn channel_kind(track: TrackInstrument, instrument: &Instrument) -> InstrumentKind {
    match track {
        TrackInstrument::Sampler(SamplerKind::Pads) => InstrumentKind::Melodic,
        _ => instrument.kind,
    }
}

/// A 40*log10 curve rather than 20*log10 because most DAWs map CC7 close to
/// it, and putting 0 dB at 100 leaves headroom for boosts.
pub fn volume_cc(volume_db: f64) -> u8 {
    (CC_VOLUME_AT_UNITY * 10f64.powf(volume_db / 40.0))
        .round()
        .clamp(0.0, 127.0) as u8
}

/// Asymmetric because MIDI has 64 steps left of centre but only 63 right of it,
/// and full right must still reach 127.
pub fn pan_cc(pan: f64) -> u8 {
    let scale = if pan < 0.0 { 64.0 } else { 63.0 };
    (64.0 + pan * scale).round().clamp(0.0, 127.0) as u8
}

fn controller(channel: u4, controller: u8, value: u8) -> TrackEvent<'static> {
    TrackEvent {
        delta: 0.into(),
        kind: TrackEventKind::Midi {
            channel,
            message: MidiMessage::Controller {
                controller: u7::new(controller),
                value: u7::new(value),
            },
        },
    }
}

/// Every track is written, muted or not: muting is an audition choice, not an
/// arrangement choice, so it must not change what reaches the DAW.
pub fn song_to_midi(valid: &ValidSong<'_>) -> Result<Vec<u8>, MidiError> {
    let song = valid.song;
    let total_steps = song.total_steps();
    let end_tick = step_to_ticks(total_steps, song.swing);

    // Audio tracks are dropped before channel assignment so they never consume
    // one of the 15 melodic channels.
    let midi_tracks: Vec<(&ValidTrack<'_>, &Instrument)> = valid
        .tracks
        .iter()
        .filter_map(|t| t.instrument.rows_definition().map(|i| (t, i)))
        .collect();
    let kinds: Vec<InstrumentKind> = midi_tracks
        .iter()
        .map(|(t, i)| channel_kind(t.instrument, i))
        .collect();
    let channels = assign_channels(&kinds);

    let mut tracks = vec![conductor_track(
        &song.name,
        song.tempo_bpm,
        song.time_signature,
        end_tick,
    )];
    for ((valid_track, instrument), channel) in midi_tracks.into_iter().zip(channels) {
        let track = valid_track.track;
        let mut events = vec![meta(0, MetaMessage::TrackName(track.name.as_bytes()))];
        if let Some(program) = instrument.midi_program {
            events.push(program_change(channel, program));
        }
        events.push(controller(channel, CC_VOLUME, volume_cc(track.volume_db)));
        events.push(controller(channel, CC_PAN, pan_cc(track.pan)));
        events.extend(note_events(
            &instrument.row_list(),
            &valid_track.notes,
            total_steps,
            song.swing,
            channel,
        ));
        tracks.push(events);
    }
    write_smf(tracks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instruments::InstrumentRegistry;
    use crate::pattern::Note;
    use crate::song::tests::{clip, lp, note, song, track, two_track_song};
    use crate::song::{resolve_track_notes, Song};
    use midly::{Format, MetaMessage as M, MidiMessage as Mm, Smf, Timing};

    fn export(song: &Song) -> Vec<u8> {
        let valid = song.validate(&InstrumentRegistry::builtin()).unwrap();
        song_to_midi(&valid).unwrap()
    }

    /// Absolute ticks let tests assert song-time placement without summing deltas.
    fn channel_events(smf: &Smf<'_>, index: usize) -> Vec<(u32, u8, Mm)> {
        let mut tick = 0;
        let mut out = Vec::new();
        for event in &smf.tracks[index] {
            tick += event.delta.as_int();
            if let TrackEventKind::Midi { channel, message } = event.kind {
                out.push((tick, channel.as_int(), message));
            }
        }
        out
    }

    fn end_tick(smf: &Smf<'_>, index: usize) -> u32 {
        let total = smf.tracks[index].iter().map(|e| e.delta.as_int()).sum();
        assert!(matches!(
            smf.tracks[index].last().unwrap().kind,
            TrackEventKind::Meta(M::EndOfTrack)
        ));
        total
    }

    fn note_ons(events: &[(u32, u8, Mm)]) -> Vec<u32> {
        events
            .iter()
            .filter(|(_, _, m)| matches!(m, Mm::NoteOn { .. }))
            .map(|e| e.0)
            .collect()
    }

    fn name_of(smf: &Smf<'_>, index: usize) -> Vec<u8> {
        smf.tracks[index]
            .iter()
            .find_map(|e| match e.kind {
                TrackEventKind::Meta(M::TrackName(n)) => Some(n.to_vec()),
                _ => None,
            })
            .unwrap()
    }

    #[test]
    fn track_layout_follows_song_order_with_drums_on_channel_ten() {
        let mut s = song(
            1,
            vec![
                track("t1", "Drums", "drums"),
                track("t2", "Bass", "bass"),
                track("t3", "Keys", "piano"),
            ],
        );
        s.name = "Late Train".into();
        let bytes = export(&s);
        let smf = Smf::parse(&bytes).unwrap();
        assert_eq!(smf.header.format, Format::Parallel);
        assert_eq!(smf.header.timing, Timing::Metrical(480.into()));
        assert_eq!(smf.tracks.len(), 4);
        assert_eq!(name_of(&smf, 0), b"Late Train");
        for (index, (name, channel)) in [("Drums", 9), ("Bass", 0), ("Keys", 1)]
            .into_iter()
            .enumerate()
        {
            assert_eq!(name_of(&smf, index + 1), name.as_bytes());
            let channels: Vec<u8> = channel_events(&smf, index + 1)
                .iter()
                .map(|e| e.1)
                .collect();
            assert!(!channels.is_empty() && channels.iter().all(|&c| c == channel));
        }
    }

    #[test]
    fn conductor_carries_tempo_and_time_signature() {
        let smf_bytes = export(&two_track_song());
        let smf = Smf::parse(&smf_bytes).unwrap();
        let metas: Vec<_> = smf.tracks[0]
            .iter()
            .filter_map(|e| match e.kind {
                TrackEventKind::Meta(m) => Some(m),
                _ => None,
            })
            .collect();
        assert!(metas.contains(&M::Tempo(625_000.into())));
        assert!(metas.contains(&M::TimeSignature(4, 2, 24, 8)));
    }

    #[test]
    fn melodic_tracks_get_a_program_change_and_drums_do_not() {
        let bytes = export(&two_track_song());
        let smf = Smf::parse(&bytes).unwrap();
        let drums = channel_events(&smf, 1);
        assert!(drums
            .iter()
            .all(|e| !matches!(e.2, Mm::ProgramChange { .. })));
        let piano = channel_events(&smf, 2);
        assert_eq!(piano[0], (0, 0, Mm::ProgramChange { program: 0.into() }));
    }

    #[test]
    fn notes_are_in_absolute_song_time() {
        let mut bass = track("t1", "Bass", "bass");
        bass.loops = vec![lp("l1", 1, vec![note("C2", 0, 4)])];
        bass.clips = vec![clip("c1", "l1", 3, 1)];
        let bytes = export(&song(4, vec![bass]));
        let smf = Smf::parse(&bytes).unwrap();
        let notes: Vec<_> = channel_events(&smf, 1)
            .into_iter()
            .filter(|e| matches!(e.2, Mm::NoteOn { .. } | Mm::NoteOff { .. }))
            .map(|e| e.0)
            .collect();
        assert_eq!(notes, vec![3840, 4320]);
    }

    #[test]
    fn clips_are_expanded_into_repeats() {
        let mut drums = track("t1", "Drums", "drums");
        drums.loops = vec![lp("l1", 1, vec![note("kick", 0, 1)])];
        drums.clips = vec![clip("c1", "l1", 1, 4)];
        let bytes = export(&song(4, vec![drums]));
        let smf = Smf::parse(&bytes).unwrap();
        assert_eq!(
            note_ons(&channel_events(&smf, 1)),
            vec![0, 1920, 3840, 5760]
        );
    }

    #[test]
    fn note_is_cut_at_the_clip_end() {
        let mut keys = track("t1", "Keys", "piano");
        keys.loops = vec![lp("l1", 2, vec![note("C4", 16, 16)])];
        keys.clips = vec![clip("c1", "l1", 1, 1)];
        // Starts past the clip end, so nothing plays at all.
        let bytes = export(&song(2, vec![keys.clone()]));
        let smf = Smf::parse(&bytes).unwrap();
        assert!(note_ons(&channel_events(&smf, 1)).is_empty());

        keys.loops = vec![lp("l1", 2, vec![note("C4", 8, 24)])];
        let bytes = export(&song(2, vec![keys]));
        let smf = Smf::parse(&bytes).unwrap();
        let offs: Vec<u32> = channel_events(&smf, 1)
            .iter()
            .filter(|e| matches!(e.2, Mm::NoteOff { .. }))
            .map(|e| e.0)
            .collect();
        assert_eq!(offs, vec![1920]);
    }

    #[test]
    fn every_track_ends_at_the_songs_final_measure() {
        let mut s = two_track_song();
        s.measures = 12;
        let bytes = export(&s);
        let smf = Smf::parse(&bytes).unwrap();
        for index in 0..smf.tracks.len() {
            assert_eq!(end_tick(&smf, index), 23040);
        }
    }

    #[test]
    fn empty_track_is_still_exported_with_controllers() {
        let s = song(1, vec![track("t1", "Pad", "synth-pad")]);
        let bytes = export(&s);
        let smf = Smf::parse(&bytes).unwrap();
        assert_eq!(smf.tracks.len(), 2);
        assert_eq!(name_of(&smf, 1), b"Pad");
        let controllers: Vec<_> = channel_events(&smf, 1)
            .into_iter()
            .filter(|e| matches!(e.2, Mm::Controller { .. }))
            .collect();
        assert_eq!(controllers.len(), 2);
    }

    fn controllers(smf: &Smf<'_>, index: usize) -> (u8, u8) {
        let value = |wanted: u8| {
            channel_events(smf, index)
                .iter()
                .find_map(|e| match e.2 {
                    Mm::Controller { controller, value } if controller.as_int() == wanted => {
                        Some(value.as_int())
                    }
                    _ => None,
                })
                .unwrap()
        };
        (value(7), value(10))
    }

    #[test]
    fn default_mixer_values() {
        let bytes = export(&two_track_song());
        let smf = Smf::parse(&bytes).unwrap();
        assert_eq!(controllers(&smf, 1), (100, 64));
    }

    #[test]
    fn extreme_mixer_values() {
        let mut quiet = track("t1", "Quiet", "piano");
        quiet.volume_db = -60.0;
        quiet.pan = -1.0;
        let mut loud = track("t2", "Loud", "piano");
        loud.volume_db = 6.0;
        loud.pan = 1.0;
        let bytes = export(&song(1, vec![quiet, loud]));
        let smf = Smf::parse(&bytes).unwrap();
        assert_eq!(controllers(&smf, 1), (3, 0));
        assert_eq!(controllers(&smf, 2), (127, 127));
    }

    #[test]
    fn mixer_curves_at_the_boundaries() {
        assert_eq!(volume_cc(0.0), 100);
        assert_eq!(volume_cc(-60.0), 3);
        assert_eq!(volume_cc(6.0), 127);
        assert_eq!(pan_cc(0.0), 64);
        assert_eq!(pan_cc(-0.5), 32);
        assert_eq!(pan_cc(0.5), 96);
        assert_eq!(pan_cc(1.0), 127);
        assert_eq!(pan_cc(-1.0), 0);
    }

    #[test]
    fn muted_track_keeps_its_notes() {
        let mut s = two_track_song();
        s.tracks[0].muted = true;
        s.tracks[0].soloed = false;
        let bytes = export(&s);
        let smf = Smf::parse(&bytes).unwrap();
        assert_eq!(note_ons(&channel_events(&smf, 1)).len(), 4);
    }

    #[test]
    fn melodic_channels_skip_ten_and_drums_may_share_it() {
        use InstrumentKind::{Drums, Melodic};
        let kinds = [Melodic, Drums, Melodic, Drums];
        let channels: Vec<u8> = assign_channels(&kinds).iter().map(|c| c.as_int()).collect();
        assert_eq!(channels, vec![0, 9, 1, 9]);

        let many = vec![Melodic; 16];
        let channels: Vec<u8> = assign_channels(&many).iter().map(|c| c.as_int()).collect();
        assert_eq!(channels[8], 8);
        assert_eq!(channels[9], 10);
        assert_eq!(channels[14], 15);
        assert!(channels.iter().all(|&c| c != 9));
        assert_eq!(channels[15], 0);
    }

    /// Pairing On with Off is how a DAW reads durations, so the round trip
    /// checks what an importer would actually see.
    fn recovered_notes(events: &[(u32, u8, Mm)]) -> Vec<(u8, u8, u32, u32)> {
        let mut out = Vec::new();
        for (index, (start, _, message)) in events.iter().enumerate() {
            if let Mm::NoteOn { key, vel } = message {
                let end = events[index + 1..]
                    .iter()
                    .find(|(_, _, m)| matches!(m, Mm::NoteOff { key: k, .. } if k == key))
                    .unwrap()
                    .0;
                out.push((key.as_int(), vel.as_int(), *start, end - start));
            }
        }
        out.sort();
        out
    }

    #[test]
    fn round_trip_matches_the_resolved_clip_notes() {
        let mut s = two_track_song();
        s.swing = 0.0;
        s.tracks[0].loops[0].notes = vec![
            Note {
                row_id: "kick".into(),
                step: 0,
                length_steps: 2,
                velocity: 111,
            },
            Note {
                row_id: "snare".into(),
                step: 4,
                length_steps: 1,
                velocity: 64,
            },
        ];
        s.tracks[1].loops[0].notes[0].velocity = 77;
        let bytes = export(&s);
        let smf = Smf::parse(&bytes).unwrap();
        let registry = InstrumentRegistry::builtin();
        for (index, track) in s.tracks.iter().enumerate() {
            let instrument = registry.get(&track.instrument).unwrap();
            let rows = instrument.row_list();
            let mut expected: Vec<(u8, u8, u32, u32)> =
                resolve_track_notes(track, s.steps_per_measure)
                    .iter()
                    .map(|n| {
                        let key = rows.iter().find(|r| r.id == n.row_id).unwrap().midi_note;
                        (key, n.velocity, n.step * 120, n.length_steps * 120)
                    })
                    .collect();
            expected.sort();
            let events = channel_events(&smf, index + 1);
            let expected_channel = if index == 0 { 9 } else { 0 };
            assert!(events.iter().all(|e| e.1 == expected_channel));
            assert_eq!(recovered_notes(&events), expected, "track {index}");
        }
    }

    #[test]
    fn swing_applies_to_song_time_like_a_pattern() {
        let mut drums = track("t1", "Drums", "drums");
        drums.loops = vec![lp("l1", 1, vec![note("kick", 1, 1)])];
        drums.clips = vec![clip("c1", "l1", 1, 1)];
        let mut s = song(1, vec![drums]);
        s.swing = 0.5;
        let bytes = export(&s);
        let smf = Smf::parse(&bytes).unwrap();
        assert_eq!(note_ons(&channel_events(&smf, 1)), vec![180]);
    }

    #[test]
    fn audio_tracks_are_skipped_without_using_a_channel() {
        use crate::song::{AudioClip, Sample, AUDIO_INSTRUMENT_ID};
        let mut s = song(
            1,
            vec![
                track("t1", "Keys", "piano"),
                track("t2", "Loops", AUDIO_INSTRUMENT_ID),
                track("t3", "Bass", "bass"),
            ],
        );
        s.samples = vec![Sample {
            id: "s1".into(),
            name: "Break".into(),
            sample_rate: 48_000,
            channels: 2,
            length_samples: 1000,
            origin: "import".into(),
        }];
        s.tracks[1].audio_clips = vec![AudioClip {
            id: "a1".into(),
            sample_id: "s1".into(),
            start_ticks: 0,
            offset_samples: 0,
            slice_samples: 1000,
            length_samples: 1000,
            looping: false,
            gain_db: 0.0,
            fade_in_samples: 0,
            fade_out_samples: 0,
        }];
        let bytes = export(&s);
        let smf = Smf::parse(&bytes).unwrap();
        assert_eq!(smf.tracks.len(), 3);
        assert_eq!(channel_events(&smf, 2)[0].1, 1);
    }
}
