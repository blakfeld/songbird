export type MidiStatus = "unsupported" | "prompt" | "granted" | "denied";

export const ALL_INPUTS = "all";

export interface MidiInputInfo {
  id: string;
  name: string;
}

// Sustain events carry the pedal value in `velocity` and controller 64 in
// `note`, so every event stays one shape for the router.
export interface MidiEvent {
  // "reset" means every held note must be released, either because the device said so or because the
  // input those notes came from is no longer the one being listened to.
  type: "on" | "off" | "sustain" | "reset";
  note: number;
  velocity: number;
  // DOMHighResTimeStamp of the message, in the same clock as performance.now().
  timeStamp: number;
}

export interface MidiSnapshot {
  status: MidiStatus;
  inputs: MidiInputInfo[];
  // "all" or an input id; kept even when that input is unplugged so it resumes on reconnect.
  selected: string;
  selectedConnected: boolean;
}

export interface MidiAccess {
  readonly status: MidiStatus;
  readonly inputs: MidiInputInfo[];
  readonly selected: string;
  getSnapshot(): MidiSnapshot;
  // Browsers prompt on first use, so this needs a user gesture unless permission was already granted.
  request(): Promise<MidiStatus>;
  select(id: string): void;
  subscribe(listener: (event: MidiEvent) => void): () => void;
  subscribeState(listener: () => void): () => void;
}

export interface MidiAccessDeps {
  requestMIDIAccess?: ((options: MIDIOptions) => Promise<MIDIAccess>) | undefined;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  // Resolves the browser's current MIDI permission without prompting; injectable because jsdom has no Permissions API.
  queryPermission?: (() => Promise<string>) | undefined;
}

export const MIDI_STORAGE_KEY = "songbird.midi.v1";

const SUSTAIN_CONTROLLER = 64;
const ALL_SOUND_OFF_CONTROLLER = 120;
const ALL_NOTES_OFF_CONTROLLER = 123;

const STATUS_NOTE_OFF = 0x80;
const STATUS_NOTE_ON = 0x90;
const STATUS_CONTROL_CHANGE = 0xb0;

// The channel nibble is masked off because every channel is accepted.
export function parseMidiMessage(
  data: ArrayLike<number>,
  timeStamp: number,
): MidiEvent | null {
  if (data.length < 3) return null;
  const kind = data[0] & 0xf0;
  const a = data[1];
  const b = data[2];
  if (kind === STATUS_NOTE_ON) {
    // Many keyboards send note-on with velocity 0 instead of note-off.
    return { type: b === 0 ? "off" : "on", note: a, velocity: b, timeStamp };
  }
  if (kind === STATUS_NOTE_OFF) {
    return { type: "off", note: a, velocity: b, timeStamp };
  }
  if (kind === STATUS_CONTROL_CHANGE && a === SUSTAIN_CONTROLLER) {
    return { type: "sustain", note: a, velocity: b, timeStamp };
  }
  if (
    kind === STATUS_CONTROL_CHANGE &&
    (a === ALL_SOUND_OFF_CONTROLLER || a === ALL_NOTES_OFF_CONTROLLER)
  ) {
    return { type: "reset", note: a, velocity: b, timeStamp };
  }
  return null;
}

interface Remembered {
  granted: boolean;
  inputId: string;
}

function readRemembered(storage: MidiAccessDeps["storage"]): Remembered {
  const fallback = { granted: false, inputId: ALL_INPUTS };
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(MIDI_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Remembered>;
    return {
      granted: parsed.granted === true,
      inputId: typeof parsed.inputId === "string" ? parsed.inputId : ALL_INPUTS,
    };
  } catch {
    return fallback;
  }
}

export function createMidiAccess(deps: MidiAccessDeps = {}): MidiAccess {
  const requestMidi =
    "requestMIDIAccess" in deps
      ? deps.requestMIDIAccess
      : typeof navigator !== "undefined" && "requestMIDIAccess" in navigator
        ? navigator.requestMIDIAccess.bind(navigator)
        : undefined;
  const storage =
    "storage" in deps
      ? deps.storage
      : typeof localStorage === "undefined"
        ? null
        : localStorage;

  const remembered = readRemembered(storage);
  let access: MIDIAccess | null = null;
  let pending: Promise<MidiStatus> | null = null;
  let snapshot: MidiSnapshot = {
    status: requestMidi ? "prompt" : "unsupported",
    inputs: [],
    selected: remembered.inputId,
    selectedConnected: remembered.inputId === ALL_INPUTS,
  };
  const eventListeners = new Set<(event: MidiEvent) => void>();
  const stateListeners = new Set<() => void>();

  const persist = (granted: boolean) => {
    try {
      storage?.setItem(
        MIDI_STORAGE_KEY,
        JSON.stringify({ granted, inputId: snapshot.selected }),
      );
    } catch {
      // Remembering is a convenience; private browsing may refuse the write.
    }
  };

  const setSnapshot = (patch: Partial<MidiSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    snapshot.selectedConnected =
      snapshot.selected === ALL_INPUTS ||
      snapshot.inputs.some((i) => i.id === snapshot.selected);
    stateListeners.forEach((l) => l());
  };

  const emitReset = () => {
    const event: MidiEvent = { type: "reset", note: 0, velocity: 0, timeStamp: performance.now() };
    eventListeners.forEach((l) => l(event));
  };

  const handleMessage = (input: MIDIInput, e: MIDIMessageEvent) => {
    if (snapshot.selected !== ALL_INPUTS && snapshot.selected !== input.id) return;
    if (!e.data) return;
    const event = parseMidiMessage(e.data, e.timeStamp);
    if (event) eventListeners.forEach((l) => l(event));
  };

  const refreshInputs = () => {
    if (!access) return;
    const inputs: MidiInputInfo[] = [];
    const before = snapshot.inputs;
    for (const input of access.inputs.values()) {
      if (input.state === "disconnected") continue;
      // Assigned on every refresh so an input that appears later is listened to.
      input.onmidimessage = (e) => handleMessage(input, e);
      inputs.push({ id: input.id, name: input.name ?? input.id });
    }
    setSnapshot({ inputs });
    // Keys held on a device that vanished never send their note-offs.
    const lost = before.filter((b) => !inputs.some((i) => i.id === b.id));
    if (lost.some((l) => snapshot.selected === ALL_INPUTS || l.id === snapshot.selected)) emitReset();
  };

  const request = (): Promise<MidiStatus> => {
    if (!requestMidi) return Promise.resolve(snapshot.status);
    if (snapshot.status === "granted") return Promise.resolve("granted");
    pending ??= requestMidi({ sysex: false }).then(
      (granted) => {
        access = granted;
        granted.onstatechange = refreshInputs;
        persist(true);
        setSnapshot({ status: "granted" });
        refreshInputs();
        return "granted" as const;
      },
      () => {
        persist(false);
        setSnapshot({ status: "denied" });
        return "denied" as const;
      },
    );
    const current = pending;
    void current.then(() => {
      if (pending === current) pending = null;
    });
    return current;
  };

  const queryPermission =
    "queryPermission" in deps
      ? deps.queryPermission
      : typeof navigator !== "undefined" && navigator.permissions
        ? async () => (await navigator.permissions.query({ name: "midi" as PermissionName })).state
        : undefined;

  // requestMIDIAccess outside a user gesture can surface a prompt or fail, so only a grant the browser
  // confirms is restored. Anything else stays at "prompt" for the player to start from a click.
  const restore = async () => {
    try {
      if ((await queryPermission?.()) === "granted") await request();
    } catch {
      // A browser that cannot answer the query is treated as not granted.
    }
  };
  // Started by the first subscriber, never by construction: the instance is created during render, and a
  // grant that resolved before every subscriber mounted would update components that are not mounted yet.
  let restoreStarted = false;
  const startRestore = () => {
    if (restoreStarted) return;
    restoreStarted = true;
    if (remembered.granted && requestMidi) void restore();
  };

  return {
    get status() {
      return snapshot.status;
    },
    get inputs() {
      return snapshot.inputs;
    },
    get selected() {
      return snapshot.selected;
    },
    getSnapshot: () => snapshot,
    request,
    select(id) {
      const changed = id !== snapshot.selected;
      setSnapshot({ selected: id });
      persist(snapshot.status === "granted");
      // Notes held on the old selection would otherwise sound until a note-off that will now be filtered out.
      if (changed) emitReset();
    },
    subscribe(listener) {
      startRestore();
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    subscribeState(listener) {
      stateListeners.add(listener);
      startRestore();
      return () => stateListeners.delete(listener);
    },
  };
}

let instance: MidiAccess | null = null;

// One instance, so navigating between pages neither re-prompts nor duplicates listeners.
export function getMidiAccess(): MidiAccess {
  // Not cached on the server, where it would report "unsupported" to the client forever.
  if (typeof window === "undefined") return createMidiAccess({ storage: null });
  return (instance ??= createMidiAccess());
}
