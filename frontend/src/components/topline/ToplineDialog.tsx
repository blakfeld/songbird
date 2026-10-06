"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useAiKeyGate } from "@/components/ai/AiKeyGate";
import { useAiKeys } from "@/components/ai/AiKeysProvider";
import { ErrorAlert } from "@/components/editor/ErrorAlert";
import { TokenCounter } from "@/components/editor/TokenCounter";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { Spinner } from "@/components/ui/Spinner";
import { focusRing, hintClass, inputClass } from "@/components/ui/classes";
import type { InstrumentInfo } from "@/generated/InstrumentInfo";
import type { ToplineLine } from "@/generated/ToplineLine";
import type { ToplineSource } from "@/generated/ToplineSource";
import type { VoicePreset } from "@/generated/VoicePreset";
import { describeError, isKeyErrorCode, type DescribedError } from "@/lib/aiKeys/keyError";
import { ApiError, generateTopline, getSongLimits } from "@/lib/api";
import { estimateTokens } from "@/lib/estimateTokens";
import { isSubmitEnter } from "@/lib/isSubmitEnter";
import { AUDIO_INSTRUMENT_ID } from "@/lib/song/audioTiming";
import { SAMPLER_KEYS_ID, SAMPLER_PADS_ID } from "@/lib/song/sampler";
import type { SongStore } from "@/lib/song/songStore";
import { toplineLimitProblem } from "@/lib/song/toplineLimits";
import { withVocalTrack, type ToplineTarget as TrackChoice } from "@/lib/song/toplineApply";
import type { Song } from "@/lib/song/types";
import { resplitWord } from "@/lib/topline/syllabify";
import { seedSyllables } from "@/lib/topline/toplineOps";
import { toplineTarget } from "@/lib/topline/toplineTarget";
import { useApiResource } from "@/lib/useApiResource";
import { useStoredValue } from "@/lib/useStoredValue";

export interface ToplineRequest {
  sectionName: string;
  // Preselects a track, as "Regenerate" does for the track the loop already lives on.
  trackId?: string;
  // The earlier source, so lines that have not changed keep the user's syllable corrections.
  source?: ToplineSource;
}

const VOICE_KEY = "songbird.topline.voice";
const VOICES: { id: VoicePreset; label: string; range: string }[] = [
  { id: "soprano", label: "Soprano", range: "C4 to A5" },
  { id: "alto", label: "Alto", range: "F3 to D5" },
  { id: "tenor", label: "Tenor", range: "C3 to A4" },
  { id: "baritone", label: "Baritone", range: "A2 to F4" },
];
const parseVoice = (raw: string): VoicePreset | null =>
  VOICES.some((v) => v.id === raw) ? (raw as VoicePreset) : null;

const NEW_VOCAL = "new-vocal";

interface Word {
  first: number;
  syllables: ToplineLine["syllables"];
}

// A syllable ending in a hyphen continues its word, which is how the preview knows where words end.
function wordsOf(line: ToplineLine): Word[] {
  const words: Word[] = [];
  let current: Word | null = null;
  line.syllables.forEach((s, i) => {
    if (!current) {
      current = { first: i, syllables: [] };
      words.push(current);
    }
    current.syllables.push(s);
    if (!s.text.endsWith("-")) current = null;
  });
  return words;
}

const wordLetters = (word: Word) => word.syllables.map((s) => s.text.replace(/-$/, "")).join("");
const hyphenated = (word: Word) => word.syllables.map((s) => s.text.replace(/-$/, "")).join("-");

function SyllablePreview({
  lines,
  onChange,
}: {
  lines: ToplineLine[];
  onChange: (lines: ToplineLine[]) => void;
}) {
  const [editing, setEditing] = useState<{ line: number; first: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const errorId = useId();
  const root = useRef<HTMLOListElement>(null);

  // The input replaces the word's buttons, so focus would otherwise fall to the page when it closes.
  const closeEditor = (lineIndex: number, first: number) => {
    setEditing(null);
    setProblem(null);
    requestAnimationFrame(() =>
      root.current?.querySelector<HTMLElement>(`[data-edit="${lineIndex}:${first}"]`)?.focus(),
    );
  };

  const toggle = (lineIndex: number, syllableIndex: number) =>
    onChange(
      lines.map((l, i) =>
        i !== lineIndex
          ? l
          : { ...l, syllables: l.syllables.map((s, j) => (j === syllableIndex ? { ...s, stressed: !s.stressed } : s)) },
      ),
    );

  const commit = (lineIndex: number, word: Word) => {
    const next = resplitWord(wordLetters(word), draft.trim());
    if (!next) {
      setProblem(`The letters must stay the same, for example ${hyphenated(word)}.`);
      return;
    }
    onChange(
      lines.map((l, i) =>
        i !== lineIndex
          ? l
          : { ...l, syllables: [...l.syllables.slice(0, word.first), ...next, ...l.syllables.slice(word.first + word.syllables.length)] },
      ),
    );
    closeEditor(lineIndex, word.first);
  };

  return (
    <ol ref={root} className="flex flex-col gap-2" aria-label="Syllables by line">
      {lines.map((line, lineIndex) => (
        <li key={lineIndex} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
          <span className="sr-only">Line {lineIndex + 1}: {line.text}</span>
          {wordsOf(line).map((word) => {
            const isEditing = editing?.line === lineIndex && editing.first === word.first;
            if (isEditing) {
              return (
                <span key={word.first} className="flex flex-col gap-1">
                  <input
                    type="text"
                    autoFocus
                    aria-label={`Split ${wordLetters(word)} with hyphens`}
                    aria-invalid={problem !== null}
                    aria-describedby={problem ? errorId : undefined}
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      setProblem(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        // The dialog's form must not submit while a word is being edited.
                        e.preventDefault();
                        e.stopPropagation();
                        commit(lineIndex, word);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        closeEditor(lineIndex, word.first);
                      }
                    }}
                    className={`${inputClass} !h-8 w-32 font-mono`}
                  />
                  {problem && (
                    <span id={errorId} role="alert" className="text-xs text-red-700 dark:text-red-400">
                      {problem}
                    </span>
                  )}
                </span>
              );
            }
            return (
              <span key={word.first} className="inline-flex items-center gap-0.5">
                {word.syllables.map((s, k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={s.stressed}
                    aria-label={s.text}
                    onClick={() => toggle(lineIndex, word.first + k)}
                    className={`rounded px-1 py-0.5 font-mono text-sm ${focusRing} ${
                      s.stressed
                        ? "bg-indigo-100 font-bold text-indigo-900 dark:bg-indigo-900/50 dark:text-indigo-100"
                        : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    }`}
                  >
                    {s.text}
                  </button>
                ))}
                <button
                  type="button"
                  aria-label={`Edit split of ${wordLetters(word)}`}
                  data-edit={`${lineIndex}:${word.first}`}
                  onClick={() => {
                    setEditing({ line: lineIndex, first: word.first });
                    setDraft(hyphenated(word));
                    setProblem(null);
                  }}
                  className={`rounded px-1 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-50 ${focusRing}`}
                >
                  <span aria-hidden="true">✎</span>
                </button>
              </span>
            );
          })}
        </li>
      ))}
    </ol>
  );
}

function Form({
  song,
  store,
  request,
  instruments,
  onAnnounce,
  guardEdit,
  onClose,
}: {
  song: Song;
  store: SongStore;
  request: ToplineRequest;
  instruments: InstrumentInfo[] | undefined;
  onAnnounce: (message: string) => void;
  guardEdit: (edit: () => void) => void;
  onClose: () => void;
}) {
  const id = useId();
  const target = useMemo(() => toplineTarget(song, request.sectionName), [song, request.sectionName]);
  const [lines, setLines] = useState<ToplineLine[]>(() => seedSyllables(target?.lines ?? [], request.source));
  const [voice, setVoice] = useStoredValue<VoicePreset>(VOICE_KEY, "tenor", parseVoice);
  const [prompt, setPrompt] = useState("");
  const [everyName, setEveryName] = useState(true);
  const [error, setError] = useState<DescribedError | null>(null);
  const [busy, setBusy] = useState(false);
  const limits = useApiResource(getSongLimits);
  const { blocked, noticeId, notice } = useAiKeyGate();
  const { refresh } = useAiKeys();
  // Closing the dialog unmounts this form, and a result that arrives afterwards must not touch the song.
  const closed = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      // Releases the track lock and the connection at once instead of when the server eventually answers.
      controller.current?.abort();
    };
  }, []);

  const melodic = useMemo(
    () =>
      song.tracks.filter((t) => {
        if (t.instrument === AUDIO_INSTRUMENT_ID || t.instrument === SAMPLER_KEYS_ID || t.instrument === SAMPLER_PADS_ID)
          return false;
        return instruments?.find((i) => i.id === t.instrument)?.kind === "melodic";
      }),
    [song.tracks, instruments],
  );
  const [choice, setChoice] = useState<string>(() =>
    request.trackId && song.tracks.some((t) => t.id === request.trackId) ? request.trackId : NEW_VOCAL,
  );

  const syllableCount = lines.reduce((n, l) => n + l.syllables.length, 0);
  const steps = target ? target.section.measures * song.steps_per_measure : 0;
  const tooMany = syllableCount > steps;
  const max = limits.data?.max_input_tokens ?? null;
  const tokens = estimateTokens(prompt);
  const overLimit = max !== null && tokens > max;
  const limitProblem = syllableCount > 0 && !tooMany ? toplineLimitProblem(request.sectionName.trim(), lines) : null;
  const canSubmit =
    target !== null && syllableCount > 0 && !tooMany && limitProblem === null && !overLimit && !busy && !blocked && limits.status === "ready";

  if (!target) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Generate topline</h2>
        <p className="text-sm">No section is linked to the heading [{request.sectionName}].</p>
        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    );
  }

  const alsoRanges = everyName ? target.others.map((o) => o.range) : [];
  const trackChoice: TrackChoice = choice === NEW_VOCAL ? { kind: "new-vocal" } : { kind: "track", trackId: choice };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !target) return;
    const snapshot = store.getState().song;
    if (!snapshot) return;
    let requestSong = snapshot;
    let trackId = choice;
    if (choice === NEW_VOCAL) {
      const drafted = withVocalTrack(snapshot);
      if (!drafted) {
        setError({ message: "The song already has 16 tracks, the most it can hold. Choose an existing track instead." });
        return;
      }
      requestSong = drafted.song;
      trackId = drafted.trackId;
    } else if (!store.getState().beginGenerating(trackId)) {
      setError({ message: "That track is already being generated." });
      return;
    }
    const locked = choice !== NEW_VOCAL;
    const { loadEpoch: epoch, generationToken: token } = store.getState();
    const source: ToplineSource = { section_name: request.sectionName.trim(), voice, lines };
    setBusy(true);
    setError(null);
    onAnnounce(`Generating a topline for ${source.section_name}…`);
    const abort = new AbortController();
    controller.current = abort;
    try {
      const result = await generateTopline({
        song: requestSong,
        track_id: trackId,
        range: target.range,
        section_name: source.section_name,
        lines,
        voice,
        prompt: prompt.trim(),
      }, abort.signal);
      if (closed.current || store.getState().loadEpoch !== epoch) return;
      let refusal: string | null = null;
      guardEdit(() => {
        refusal = store.getState().applyTopline({
          trackChoice,
          range: result.range,
          notes: result.notes,
          source,
          alsoRanges,
        });
      });
      if (refusal !== null) {
        setError({ message: refusal });
        onAnnounce(`Topline generation failed. ${refusal}`);
        return;
      }
      const { stressed_on_beat: on, stressed_syllables: total } = result.prosody;
      onAnnounce(`Generated a ${source.section_name} topline. ${on} of ${total} stressed syllables on the beat.`);
      onClose();
    } catch (err) {
      if (abort.signal.aborted) {
        onAnnounce("Topline generation cancelled.");
        return;
      }
      if (closed.current || store.getState().loadEpoch !== epoch) return;
      if (err instanceof ApiError && isKeyErrorCode(err.code)) void refresh();
      const described = describeError(err);
      setError(described);
      onAnnounce(`Topline generation failed. ${described.message}`);
    } finally {
      if (locked) store.getState().endGenerating(token);
      if (!closed.current) setBusy(false);
    }
  }

  const sectionLabel = `${target.section.name}, measures ${target.range.start_measure} to ${target.range.end_measure}`;

  return (
    <form onSubmit={submit} aria-busy={busy} className="flex flex-col gap-4">
      <h2 id={`${id}-title`} className="text-lg font-semibold">
        Generate topline
      </h2>
      <p className="text-sm">
        Section: <strong>{sectionLabel}</strong>
      </p>
      {limitProblem && (
        <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">
          This topline cannot be generated: {limitProblem}.
        </p>
      )}
      {error && <ErrorAlert message={error.message} action={error.action} />}
      {limits.status === "error" && <ErrorAlert message="Couldn't load generation limits." onRetry={limits.retry} />}
      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Syllables</h3>
          {lines.length === 0 ? (
            <p className={hintClass}>There are no lyric lines under [{request.sectionName}] yet.</p>
          ) : (
            <>
              <p className={hintClass}>
                Click a syllable to toggle its stress. Use the pencil to re-split a word with hyphens, such as ev-ery.
              </p>
              <SyllablePreview lines={lines} onChange={setLines} />
            </>
          )}
          <p className={hintClass}>
            {syllableCount} {syllableCount === 1 ? "syllable" : "syllables"} for {steps} steps
          </p>
          {tooMany && (
            <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">
              These {syllableCount} syllables do not fit the {steps} steps of {target.section.name}. Shorten the lyrics or
              make the section longer.
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-4">
          <Field label="Voice" htmlFor={`${id}-voice`}>
            <select
              id={`${id}-voice`}
              value={voice}
              onChange={(e) => setVoice(e.target.value as VoicePreset)}
              className={`${inputClass} w-48`}
            >
              {VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} ({v.range})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Target track" htmlFor={`${id}-track`}>
            <select
              id={`${id}-track`}
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              className={`${inputClass} w-56`}
            >
              <option value={NEW_VOCAL}>New Vocal track</option>
              {melodic.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Style (optional)" htmlFor={`${id}-prompt`}>
          <textarea
            id={`${id}-prompt`}
            rows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. soaring, mostly stepwise"
            onKeyDown={(e) => {
              if (isSubmitEnter(e)) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            aria-describedby={`${id}-token-count`}
            aria-invalid={overLimit}
            className={`${inputClass} h-auto w-full resize-y py-2`}
          />
        </Field>
        <TokenCounter id={`${id}-token-count`} count={tokens} max={max} />
        {target.others.length > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={everyName}
              onChange={(e) => setEveryName(e.target.checked)}
              className={`size-4 ${focusRing}`}
            />
            Place on every {target.section.name} ({target.others.length + 1} sections)
          </label>
        )}
      </fieldset>
      <p className={hintClass}>
        Replaces what the track plays over {target.section.name}. Undo restores it, and the lyrics are not changed.
      </p>
      {notice}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!canSubmit} aria-describedby={noticeId}>
          {busy && <Spinner />}
          {busy ? "Generating…" : "Generate"}
        </Button>
      </div>
    </form>
  );
}

export function ToplineDialog({
  request,
  song,
  store,
  instruments,
  onAnnounce,
  guardEdit,
  onClose,
}: {
  request: ToplineRequest | null;
  song: Song;
  store: SongStore;
  instruments: InstrumentInfo[] | undefined;
  onAnnounce: (message: string) => void;
  guardEdit: (edit: () => void) => void;
  onClose: () => void;
}) {
  return (
    <ModalDialog
      open={request !== null}
      onClose={onClose}
      label="Generate topline"
      className="m-auto max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-2xl p-6"
    >
      {request && (
        <Form
          song={song}
          store={store}
          request={request}
          instruments={instruments}
          onAnnounce={onAnnounce}
          guardEdit={guardEdit}
          onClose={onClose}
        />
      )}
    </ModalDialog>
  );
}
