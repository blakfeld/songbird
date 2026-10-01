import type { KeyboardEvent } from "react";

// Safari fires compositionend before the Enter that confirms an IME candidate, so isComposing is already
// false by then; keyCode 229 is the only remaining sign that the key belongs to the IME.
export function isSubmitEnter(e: KeyboardEvent): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229;
}
