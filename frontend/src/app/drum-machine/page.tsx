import type { Metadata } from "next";
import { PatternEditorPage } from "@/components/editor/PatternEditorPage";

export const metadata: Metadata = { title: "Drum Machine" };

export default function DrumMachinePage() {
  return <PatternEditorPage instrumentId="drums" title="Drum Machine" />;
}
