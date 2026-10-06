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
  autoFocus?: boolean;
  label?: string;
  /** Shown under the field when there's nothing more urgent to say. */
  hint?: string;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
};

/** Natural-language change request for one concept ("thinner ring, matte black"). */
export function RefinementInput({
  onSubmit,
  pending,
  disabledReason,
  autoFocus,
  label = "Refine this concept",
  hint,
  textareaRef,
}: RefinementInputProps) {
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
      <label htmlFor={id} className="text-headline text-ink">
        {label}
      </label>
      <textarea
        ref={textareaRef}
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
        autoFocus={autoFocus}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-help`}
        placeholder="e.g. Make the horns smaller, make the body more mechanical, and make the face slightly more aggressive."
        className={cn(inputClasses, "resize-none py-3 leading-relaxed disabled:opacity-60")}
      />
      <div className="flex items-center justify-between gap-3">
        <p id={`${id}-help`} className={cn("text-caption", error ? "text-danger" : "text-ink-3")} role={error ? "alert" : undefined}>
          {error ?? disabledReason ?? hint ?? "Describe what to change. Everything you don't mention stays the same."}
        </p>
        <Button type="submit" size="sm" loading={pending} disabled={disabled} icon={<Send className="size-3.5" />}>
          Refine
        </Button>
      </div>
      <p className="text-caption text-ink-3" aria-hidden="true">
        ⌘/Ctrl + Enter to send
      </p>
    </form>
  );
}
