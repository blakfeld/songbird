# Tasks

## 1. Document and backend

- [ ] 1.1 Confirm that `add-audio-tracks` is merged (`Song.samples`, `TrackInstrument`, `sampleStore`, and the library exist). Verify that `cargo test -p music` and `pnpm vitest sampleStore` pass on main.
- [ ] 1.2 Add `TrackInstrument::Sampler(Keys|Pads)` with built-in row sets, `SamplerSettings`, and validation (D1, D3): sample references, ranges, unique pad rows, tone kind rules, and note rows. Run `just gen-types` and update the schema snapshot. Add fixtures. Verify with `cargo test -p music` covering "Keys row range", "Pad sample must be in the song", and "Wrong-kind tone knob".
- [ ] 1.3 Handle sampler tracks in `song_midi.rs` (melodic channels, no Program Change, pad notes 36–51), include keys and exclude pads in `context.rs`, and reject sampler generation targets. Verify with `api/tests/songs.rs` "Pads export", `chat.rs` "Keys used as context", and `track_generation.rs` "Generate refused on a sampler".
- [ ] 1.4 Run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` from `backend/`. Verify that both pass.

## 2. Frontend model and sound

- [ ] 2.1 Mirror the sampler validation in TS via the shared fixtures. Add `withBuiltIns()` sampler instrument infos to the instrument lookup. Add sampler track creation ("Sampler"/"Pads" naming) and the sampler ops (choose, clear, root, one-shot, pad gain and pitch, with `samples` bookkeeping). Extend `collectGarbage` to count sampler references. Verify with `songOps`/`samplerOps` tests and a `sampleStore` test where a sample used only by a pad is kept.
- [ ] 2.2 Implement `samplerSource` (D2) and register both ids in `registry.ts`. Verify with `samplerSource.test.ts` using mocked Tone: "Pitched up an octave" (playbackRate 2), "Sustained note releases", "Pad one-shot", voice stealing at 33 notes, and a missing buffer staying silent.

## 3. UI

- [ ] 3.1 Have `ui-designer` specify the sampler strip, the pad row-label drop target and menu, and the empty and missing pad states. Verify that the design notes are delivered before task 3.2.
- [ ] 3.2 Add "Sampler (keys)" and "Sampler (pads)" to Add Track. Build `SamplerStrip` and the pad row labels with drop, menu, and knobs. Verify with Vitest "Add a pad sampler", "Drop a kick on a pad", and "Choose a sample for keys" (a MIDI note-on through the fake MIDI input triggers the source at the expected rate).
- [ ] 3.3 Run `pnpm lint`, `tsc`, and `pnpm build` in `frontend/`. Verify that all pass.

## 4. Integration

- [ ] 4.1 Add a Playwright test: import a WAV fixture, add a Pads track, drop the sample on Pad 1, add notes on that row, play, check that the sampler voice starts, download a project bundle, and check that the sample is included. Verify with `just test-e2e`.
- [ ] 4.2 Run `just lint` and `just test`, then run `code-reviewer` on the branch. Verify that everything is green and the review findings are resolved.
