import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { DesignBriefForm } from "@/components/studio/design-brief-form";

export const metadata: Metadata = { title: "New project" };

export default function NewProjectPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-10">
      <div className="flex flex-col gap-6">
        <Link
          href="/projects"
          className="pressable -ml-1 inline-flex w-fit items-center gap-1.5 rounded-full px-1 text-callout text-ink-2 hover:text-ink"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Projects
        </Link>
        <div className="flex flex-col gap-3">
          <h1 className="text-display text-ink">Describe your idea</h1>
          <p className="max-w-xl text-body text-ink-2">
            Tell us what to design. We&apos;ll turn the brief into distinct concepts you can review, refine and approve.
          </p>
        </div>
      </div>
      <div className="rounded-[1.75rem] border border-hairline bg-surface p-5 sm:p-8">
        <DesignBriefForm />
      </div>
    </div>
  );
}
