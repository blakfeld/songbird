# Tasks

## 1. Track generation `take` hint (songs/track-generation)

- [ ] 1.1 Add `Take { index, count }` and an optional `take` field to `TrackGenerateBody` in `music/src/track_generation.rs`, with serde and ts-rs derives, and validate it in `ValidTrackRequest` (`invalid_take`: count 2–6, index 1–count, no extra fields). Run `just gen-types`. Verify with unit tests for each boundary (`{1,2}` and `{6,6}` accepted; `{0,4}`, `{5,4}`, `{1,1}`, `{1,9}`, and an unknown field rejected).
- [ ] 1.2 Add the take instruction to the track-generation prompt builder, emitted only when `take` is `Some` (D2). Verify that the existing prompt snapshot tests are unchanged, and that a new snapshot test shows the line for `{2,4}`.
- [ ] 1.3 Fold `take.index` into the mock's `stable_hash` and example rotation, with the onset shift for single-example instruments (D2). Verify with Rust tests that takes 1–4 are pairwise different for every instrument, that the same take repeats exactly, and that requests without `take` produce the same notes as before (compare against a fixture captured before the change).
- [ ] 1.4 Add `invalid_take` to `api/src/error.rs` and add API integration tests on `/api/v1/songs/tracks/generate`. Verify that a valid take returns `200`, that an invalid take returns `422 invalid_take` and the provider double records no call, and that the AI meter counts exactly one request per take.
- [ ] 1.5 Add an `#[ignore]` live Ollama test asserting that 4 takes of one prompt are not all identical, and wire it into `just test-live-ollama`. Verify that `just test` skips it.
- [ ] 1.6 From `backend/`, run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`, and verify that both pass.

## 2. Snapshot storage and API (songs/project-snapshots)

- [ ] 2.1 Add `migrations/sqlite/0004_project_snapshots.sql` and `migrations/postgres/0004_project_snapshots.sql` (D6). Verify that the migration tests run on both backends, and that deleting a project or user cascades to the snapshots on both.
- [ ] 2.2 Implement `api/src/snapshot_store.rs`: `list`, `create`, `get`, `rename`, and `delete`, each scoped by `owner_id`, with the transaction order from D7 (lock owner, ownership check, expiry, de-duplication, manual cap, insert, auto prune, quota-driven prune). Compute `facts` and `song_hash` at create time. Verify with store tests on both backends covering: pruning the 51st auto snapshot, 30-day expiry on list, the manual cap of 25, de-duplication returning the existing id, quota pruning followed by `Limit`, and two concurrent auto creates at 49 ending at exactly 50.
- [ ] 2.3 Extend `project_store::count_and_bytes` to include snapshot bytes. Verify with a test where snapshots push a project save over 100 MiB and the save returns `409 project_limit`.
- [ ] 2.4 Add `api/src/snapshots.rs` routes (`GET`/`POST /api/v1/projects/{id}/snapshots`, and `GET`/`PATCH`/`DELETE …/{snapshot_id}`), merged into `projects::router()`. Add `snapshot_limiter` to `AppState` (30 per minute), and add the `invalid_snapshot` and `snapshot_limit` codes (D11). Verify with integration tests for every scenario in the spec: `404` for another user's project and for a snapshot under the wrong project; `422` validation, including `id_mismatch`; `201` versus de-duplicated `200`; rename turning an auto snapshot manual; rename refused at the manual cap; `204` delete; unknown fields round-tripping; and `429` with `Retry-After` on the 31st create in a minute.
- [ ] 2.5 Document the snapshot endpoints and limits wherever the projects API is documented (the `backend/` README or the API docs), and verify that the documented request examples match the integration tests.
- [ ] 2.6 From `backend/`, run `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings`, and verify that both pass.

## 3. Store foundations: selection, preview overlay, undo rules

- [ ] 3.1 Add `barSelection` to the song store, outside history, cleared by Escape, by selecting another track, and by `loadSong` (D5). Verify with Vitest tests that a selection is clamped to 32 measures and to measure 128, and that setting it adds no undo step.
- [ ] 3.2 Add the `preview` overlay and the `displaySong` selector (D3). While a preview is set, every editing action, undo, and redo must be refused. Point the arrangement, the lanes, and the playback scheduler at `displaySong`. Verify with Vitest tests that a preview never changes `song`, `past`, or `future`, that exiting returns the identical `song` object, and that autosave does not fire during a preview.
- [ ] 3.3 Check that the playback scheduler reschedules at the current position when the displayed song changes. Fix it if it does not. Verify with a Vitest scheduler test that swapping the displayed song mid-playback keeps the transport position and does not stop.
- [ ] 3.4 Add the `keepTake` store action (D4) and the `restoreSnapshot` store action (D9), each as one `edit`. Verify with Vitest tests:
  - keep plus 2 spares is undone by one undo;
  - keep is refused as a whole at `MAX_LOOPS`, and the refusal reports how many spares fit;
  - restore keeps `id`, `chat`, and `lyric_chat`, and takes the lyrics from the snapshot;
  - one undo after a restore brings back the arrangement.

## 4. Variations UI (songs/variations)

- [ ] 4.1 Add Shift-drag and Shift-click bar selection to `TrackLane`, with a highlighted range and an action bar and context-menu entries for "Regenerate bars" and "Takes…" (hidden on audio tracks). Verify with React Testing Library tests for selecting, clamping, Escape, and the menu entries offered.
- [ ] 4.2 Make "Regenerate bars" open `TrackGenerateDialog` with the custom range filled in and the session-remembered prompt for the track (D5). Verify with RTL tests for the range being filled in and the prompt being remembered and kept empty when there is none.
- [ ] 4.3 Build the Takes dialog: prompt with `TokenCounter`, count 2–6 defaulting to 4, the "uses N AI requests" note, and the range taken from the bar selection or the selected clip. Verify with RTL tests for the default count, the cost text, and the clip range.
- [ ] 4.4 Implement `useVariations` (D4): fan-out with at most 2 in flight, a per-take state of pending, ready, or failed, Retry, `Retry-After` messaging, aborting on end or when `loadEpoch` changes, and holding the generation lock. Verify with Vitest tests using a mocked `api.generateTrack`: take indexes 1..N are sent; a third-take `502` leaves the others ready; a `429` shows the retry time; opening another song aborts everything and releases the lock.
- [ ] 4.5 Build the Takes panel in the editor dock: Original and the takes list, choosing a take sets the preview via `applyGeneratedRange`, Compare and the `C` shortcut (ignored in text fields), Keep, spare checkboxes, Discard, and looping the range on start and restoring it on end. Verify with RTL tests: choosing a take changes the displayed notes only inside the range; `C` toggles; Discard leaves the song identical and restores the loop region; Keep is one undo step.
- [ ] 4.6 Make blocked actions during a session (generate, chat, section edits, tempo and meter changes, undo, redo) show the "takes session is open" message. Verify with an RTL test that trying to delete a section shows the message and leaves the section in place.

## 5. Snapshots UI (songs/project-snapshots)

- [ ] 5.1 Add the snapshot client to `lib/song/projectsApi.ts` (list, create, get, rename, delete) and add the new error codes to the error-message table. Verify with Vitest tests using a mocked fetch for success and for each error shape.
- [ ] 5.2 Implement `lib/song/autoSnapshot.ts`, `snapshotThenApply` (D8), and wire it into `useTrackGeneration`, `useChat` (only when a track is added), and `keepTake`. Verify with Vitest tests:
  - the snapshot body is the pre-change song;
  - the change is applied before the post resolves;
  - a failed post shows the notice and still applies the change;
  - a reply-only chat posts nothing;
  - a song without a project id skips the snapshot and shows the notice.
- [ ] 5.3 Implement `lib/song/snapshotDiff.ts` (D10). Verify with a table-driven Vitest test: track added or removed by id, tempo, meter, key, length, and the "Same tracks and settings" case.
- [ ] 5.4 Build the History tab in `RightColumnTabs`: the list with labels or reason text, relative time, the diff summary and the storage total; Save snapshot with an optional name; Rename; Delete with confirmation; disabled with a reason during generation or a takes session. Verify with RTL tests for each action and for the disabled state.
- [ ] 5.5 Build Preview (fetch the snapshot, set the preview overlay, show a banner with Restore and Exit) and Restore (wait for the "before restore" snapshot, ask for confirmation only when that fails, then `restoreSnapshot`). Verify with RTL tests: Exit leaves the song and undo stack identical; Restore updates the song and lists a "Before restore" entry; a failed pre-snapshot shows the confirmation.

## 6. End-to-end and checks

- [ ] 6.1 Add `frontend/e2e/variations.spec.ts` (mock provider). It should:
  1. Create a song with Drums and Bass.
  2. Select measures 1–4 on Bass and request 4 takes.
  3. Audition take 2 during playback and press `C`, checking that playback keeps running.
  4. Keep take 2 with take 3 as a spare, and check the loop menu.
  5. Undo once and check that the Bass track is back to how it was.
  6. Reload and check that no takes remain.

  Verify with `pnpm test:e2e`.
- [ ] 6.2 Add `frontend/e2e/snapshots.spec.ts` (mock provider). It should:
  1. Generate a track and check that History shows a "Before track generation" entry with the diff.
  2. Save a named snapshot.
  3. Preview it and exit, and check that the song is unchanged.
  4. Restore it, reload, and check the song and the "Before restore" entry.

  Verify with `pnpm test:e2e`.
- [ ] 6.3 Run `just lint`, `just test`, and `openspec validate add-variations-and-snapshots --strict`, and verify that all of them pass.
