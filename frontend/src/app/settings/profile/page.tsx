import type { Metadata } from "next";
import { ProfilePage } from "@/components/settings/ProfilePage";

export const metadata: Metadata = { title: "Profile" };

export default function Profile() {
  return <ProfilePage />;
}
