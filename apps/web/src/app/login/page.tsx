import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/studio/login-form";
import { gateConfig, safeNext } from "@/lib/server/session";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage(props: PageProps<"/login">) {
  const next = safeNext((await props.searchParams).next);
  if (!gateConfig()) redirect(next);
  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-8 pt-10 sm:pt-20">
      <div className="flex flex-col gap-2">
        <h1 className="text-title text-ink">Sign in to 3D Studio</h1>
        <p className="text-callout text-ink-2">Enter the studio password to continue.</p>
      </div>
      <div className="rounded-[1.75rem] border border-hairline bg-surface p-5 sm:p-6">
        <LoginForm next={next} />
      </div>
    </div>
  );
}
