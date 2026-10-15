import Link from "next/link";
import { buttonClass } from "@/components/ui/Button";
import { loginHref } from "@/lib/listen/session";

// A link rather than a button because it navigates; it returns to this page so the visitor chooses the action themselves afterwards.
export function SignInLink({ token, children }: { token: string; children: React.ReactNode }) {
  return (
    <Link href={loginHref(token)} className={buttonClass("secondary")}>
      {children}
    </Link>
  );
}
