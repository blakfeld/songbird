import type { Metadata } from "next";
import { StudioPage } from "@/components/studio/StudioPage";

export const metadata: Metadata = { title: "Studio" };

export default function Studio() {
  return <StudioPage />;
}
