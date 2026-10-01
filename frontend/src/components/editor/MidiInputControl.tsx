"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button, buttonClass } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { hintClass } from "@/components/ui/classes";
import { Menu, menuItemClass, menuPanelClass } from "@/components/studio/Menu";
import { ALL_INPUTS, type MidiAccess } from "@/lib/midi/access";
import { useMidiState } from "./useMidiState";

const iconClass = "size-4 shrink-0";
const triggerClass = `${buttonClass("secondary")} px-4 py-2 min-w-0 max-w-40 sm:max-w-56`;

function KeyboardIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={iconClass}
    >
      <rect x="2.5" y="5" width="15" height="10" rx="1.5" />
      <path d="M6.5 5v6M10 5v6M13.5 5v6" />
    </svg>
  );
}

function Check({ visible }: { visible: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${iconClass} ${visible ? "" : "invisible"}`}
    >
      <path d="M4 10.5l4 4 8-8.5" />
    </svg>
  );
}

const UNSUPPORTED_TEXT =
  "MIDI keyboards aren't supported in this browser. To play or record with one, open Songbird in Chrome, Edge, or Firefox. Everything else on this page still works.";
const DENIED_TEXT =
  "This site isn't allowed to use MIDI devices. Allow MIDI in your browser's site settings, then try again. Everything else on this page still works.";

function Disclosure({
  label,
  text,
  onRetry,
}: {
  label: string;
  text: string;
  onRetry?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div
      ref={root}
      className="relative"
      onKeyDown={(e) => {
        if (open && e.key === "Escape") {
          e.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-describedby={`${id}-text`}
        onClick={() => setOpen((o) => !o)}
        className={triggerClass}
      >
        <KeyboardIcon />
        <span className="truncate">{label}</span>
        <span aria-hidden="true">▾</span>
      </button>
      <span id={`${id}-text`} className="sr-only">
        {text}
      </span>
      {open && (
        <div
          id={id}
          className={`absolute left-0 z-50 mt-1 ${menuPanelClass} w-72 max-w-[calc(100vw-2rem)] p-3 text-sm text-zinc-700 dark:text-zinc-300`}
        >
          {text}
          {onRetry && (
            <Button className="mt-3" onClick={onRetry}>
              Try again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function MidiInputControl({
  midi,
  onAnnounce,
}: {
  midi?: MidiAccess;
  onAnnounce?: (msg: string) => void;
}) {
  const { access, snapshot } = useMidiState(midi);
  const [requesting, setRequesting] = useState(false);
  const [openOnMount, setOpenOnMount] = useState(false);
  const { status, inputs, selected, selectedConnected } = snapshot;

  const selectedName = inputs.find((i) => i.id === selected)?.name;
  // The chosen device's name survives unplugging only while it has been seen this session.
  const [lastName, setLastName] = useState<string | undefined>(undefined);
  if (selectedName && selectedName !== lastName) setLastName(selectedName);
  const deviceName = selectedName ?? lastName ?? "Selected input";

  const prevConnected = useRef(selectedConnected);
  const prevSelected = useRef(selected);
  useEffect(() => {
    // A different choice is the user's own action, which the trigger's new name already reports.
    if (prevSelected.current === selected && prevConnected.current !== selectedConnected) {
      onAnnounce?.(`${deviceName} ${selectedConnected ? "reconnected" : "disconnected"}.`);
    }
    prevSelected.current = selected;
    prevConnected.current = selectedConnected;
  }, [selected, selectedConnected, deviceName, onAnnounce]);

  const request = async () => {
    setRequesting(true);
    // Set first: the menu mounts as soon as access flips to granted, before this await resumes.
    setOpenOnMount(true);
    const result = await access.request();
    setRequesting(false);
    if (result === "granted") {
      onAnnounce?.("MIDI connected.");
    } else if (result === "denied") {
      setOpenOnMount(false);
      onAnnounce?.("MIDI access was blocked.");
    }
  };

  if (status === "unsupported") {
    return <Disclosure label="MIDI not supported" text={UNSUPPORTED_TEXT} />;
  }
  if (status === "denied") {
    return <Disclosure label="MIDI blocked" text={DENIED_TEXT} onRetry={() => void request()} />;
  }
  if (status === "prompt") {
    return (
      <Button
        aria-busy={requesting}
        aria-disabled={requesting}
        onClick={() => {
          if (!requesting) void request();
        }}
      >
        {requesting ? (
          <>
            <Spinner />
            Waiting for permission…
          </>
        ) : (
          <>
            <KeyboardIcon />
            Connect MIDI
          </>
        )}
      </Button>
    );
  }

  const label =
    selected === ALL_INPUTS
      ? inputs.length === 0
        ? "No keyboard"
        : "All inputs"
      : selectedConnected
        ? deviceName
        : `${deviceName} (disconnected)`;
  const disconnectedChosen = selected !== ALL_INPUTS && !selectedConnected;

  return (
    <Menu
      label="MIDI input"
      triggerLabel={`MIDI input: ${label}`}
      defaultOpen={openOnMount}
      triggerClassName={triggerClass}
      trigger={
        <>
          <KeyboardIcon />
          <span className="truncate">{label}</span>
          <span aria-hidden="true">▾</span>
        </>
      }
      panelClassName="w-72 max-w-[calc(100vw-2rem)]"
      align="left"
    >
      {(close) => (
        <>
          <p
            role="presentation"
            className="px-3 pt-1.5 pb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400"
          >
            MIDI input
          </p>
          <InputItem
            checked={selected === ALL_INPUTS}
            onChoose={() => {
              access.select(ALL_INPUTS);
              close();
            }}
            name="All inputs"
          />
          {inputs.map((input) => (
            <InputItem
              key={input.id}
              checked={selected === input.id}
              onChoose={() => {
                access.select(input.id);
                close();
              }}
              name={input.name}
            />
          ))}
          {disconnectedChosen && (
            <InputItem checked name={deviceName} tag="Disconnected" onChoose={close} />
          )}
          <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
          <p className={`${hintClass} px-3 py-1.5`}>
            {inputs.length === 0
              ? "No MIDI keyboards connected. Plug one in and it appears here."
              : "Plug in a keyboard and it appears here."}
          </p>
        </>
      )}
    </Menu>
  );
}

function InputItem({
  name,
  checked,
  tag,
  onChoose,
}: {
  name: string;
  checked: boolean;
  tag?: string;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onClick={onChoose}
      className={menuItemClass}
    >
      <Check visible={checked} />
      <span className="truncate">{name}</span>
      {tag && (
        <span className="ml-auto shrink-0 text-xs text-zinc-600 dark:text-zinc-400">{tag}</span>
      )}
    </button>
  );
}
