import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createInputOwner } from "@/lib/audio/recorder/trackInput";
import { AudioInputPopover } from "./AudioInputPopover";

function renderPopover(locked: boolean) {
  const onChoice = vi.fn();
  render(
    <AudioInputPopover
      open
      anchor={{ x: 0, y: 0 }}
      trackId="t1"
      trackName="Vocals"
      owner={createInputOwner()}
      env={{ permission: "granted", devices: [{ deviceId: "d0", label: "Scarlett 2i2" }] }}
      view={{ status: "ready", fellBack: false, channelCount: 2, clipped: false, revision: 1 }}
      choice={{ channels: 1 }}
      onChoice={onChoice}
      locked={locked}
      onRetry={() => {}}
      onClose={() => {}}
      returnFocusTo={() => null}
      anchorElement={() => null}
      onAnnounce={() => {}}
    />,
  );
  return onChoice;
}

describe("input popover while a take is recording", () => {
  it("offers the device and channel choices when idle", () => {
    renderPopover(false);
    expect(screen.getByRole("radio", { name: "Scarlett 2i2" })).toBeEnabled();
    expect(screen.getByRole("radio", { name: "Stereo" })).toBeEnabled();
    expect(screen.queryByText("Stop recording to change the input.")).not.toBeInTheDocument();
  });

  it("disables them and says why, since changing the input would cut the take's capture", () => {
    renderPopover(true);
    expect(screen.getByRole("radio", { name: "Scarlett 2i2" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Mono" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Stereo" })).toBeDisabled();
    expect(screen.getByText("Stop recording to change the input.")).toBeInTheDocument();
  });
});
