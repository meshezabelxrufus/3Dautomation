"use client";

import { Send } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { inputClasses } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { refinementSchema } from "@/lib/validation/project";

type RefinementInputProps = {
  onSubmit: (feedback: string) => Promise<boolean>;
  pending?: boolean;
  /** When set, the input is disabled and this explains why. */
  disabledReason?: string | null;
};

/** Natural-language change request for one concept ("thinner ring, matte black"). */
export function RefinementInput({ onSubmit, pending, disabledReason }: RefinementInputProps) {
  const id = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const disabled = Boolean(disabledReason) || pending;

  async function submit() {
    const parsed = refinementSchema.safeParse(value);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Describe what should change.");
      return;
    }
    setError(null);
    if (await onSubmit(parsed.data)) setValue("");
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={id} className="text-eyebrow text-ink-3">
        Refine this concept
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        rows={3}
        maxLength={1000}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-help`}
        placeholder="e.g. Sharper edges and a matte black finish. Keep the overall shape and pose."
        className={cn(inputClasses, "resize-none py-3 leading-relaxed disabled:opacity-60")}
      />
      <div className="flex items-center justify-between gap-3">
        <p id={`${id}-help`} className={cn("text-caption", error ? "text-danger" : "text-ink-3")} role={error ? "alert" : undefined}>
          {error ?? disabledReason ?? "Describe what to change and what to keep. ⌘/Ctrl + Enter to send."}
        </p>
        <Button type="submit" size="sm" loading={pending} disabled={disabled} icon={<Send className="size-3.5" />}>
          Refine
        </Button>
      </div>
    </form>
  );
}
