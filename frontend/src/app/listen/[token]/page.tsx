import type { Metadata } from "next";
import { ListenPage } from "@/components/listen/ListenPage";

// The response header from next.config covers crawlers that read headers; this covers the ones that read the page.
export const metadata: Metadata = {
  title: "Shared song",
  robots: { index: false, follow: false },
};

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ListenPage token={token} />;
}
