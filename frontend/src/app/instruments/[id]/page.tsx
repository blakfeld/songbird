import { redirect } from "next/navigation";
import { InstrumentPage } from "@/components/editor/InstrumentPage";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // The drum machine keeps one canonical URL.
  if (id === "drums") redirect("/drum-machine");
  return <InstrumentPage id={id} />;
}
