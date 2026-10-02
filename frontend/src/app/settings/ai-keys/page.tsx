import type { Metadata } from "next";
import { AiKeysPage } from "@/components/settings/AiKeysPage";

export const metadata: Metadata = { title: "AI keys" };

export default function AiKeys() {
  return <AiKeysPage />;
}
