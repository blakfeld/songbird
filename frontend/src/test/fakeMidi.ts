// Plain objects with no test-runner imports, so Playwright's init script can reuse the shape.
export interface FakeMidiInput {
  id: string;
  name: string;
  type: "input";
  state: "connected" | "disconnected";
  onmidimessage: ((e: { data: Uint8Array; timeStamp: number }) => void) | null;
}

export interface FakeMidi {
  requestMIDIAccess: (options: { sysex?: boolean }) => Promise<MIDIAccess>;
  requests: { sysex?: boolean }[];
  connect(id: string, name?: string): void;
  disconnect(id: string): void;
  send(inputId: string, bytes: number[], timeStamp?: number): void;
}

export function createFakeMidi(
  options: { inputs?: { id: string; name: string }[]; deny?: boolean } = {},
): FakeMidi {
  const inputs = new Map<string, FakeMidiInput>();
  const access = {
    inputs,
    onstatechange: null as (() => void) | null,
  };
  const add = (id: string, name: string) => {
    inputs.set(id, { id, name, type: "input", state: "connected", onmidimessage: null });
  };
  for (const i of options.inputs ?? []) add(i.id, i.name);

  const requests: { sysex?: boolean }[] = [];
  return {
    requests,
    requestMIDIAccess(opts) {
      requests.push(opts);
      return options.deny
        ? Promise.reject(new DOMException("denied", "SecurityError"))
        : Promise.resolve(access as unknown as MIDIAccess);
    },
    connect(id, name = id) {
      const existing = inputs.get(id);
      if (existing) existing.state = "connected";
      else add(id, name);
      access.onstatechange?.();
    },
    disconnect(id) {
      // Kept in the map as Chromium does, so consumers must read `state`.
      const input = inputs.get(id);
      if (input) input.state = "disconnected";
      access.onstatechange?.();
    },
    send(inputId, bytes, timeStamp = 0) {
      inputs.get(inputId)?.onmidimessage?.({ data: new Uint8Array(bytes), timeStamp });
    },
  };
}
