"use client";

import { Sparkles } from "lucide-react";
import { useActionState, useRef, useState } from "react";
import { createProjectAction, type CreateProjectState } from "@/app/projects/actions";
import { Button } from "@/components/ui/button";
import { describedBy, Field, inputClasses } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import {
  BRIEF_MAX,
  createProjectSchema,
  IDEA_COUNT_MAX,
  IDEA_COUNT_MIN,
  type CreateProjectFieldErrors,
} from "@/lib/validation/project";
import { ErrorState } from "./error-state";

const EXAMPLE_BRIEF =
  "I want a futuristic mechanical wolf bust with sharp geometric armor, collectible statue proportions and an aggressive expression.";

type Values = { projectName: string; clientName: string; designBrief: string; ideaCount: string };
type FieldName = keyof Values;

const shape = createProjectSchema.shape;

function validateField(name: FieldName, value: string): string | undefined {
  const result = shape[name].safeParse(value);
  return result.success ? undefined : result.error.issues[0]?.message;
}

/**
 * Project name, client, and a large natural-language brief. Validation runs inline
 * (on blur, then live) with the same rules the server enforces.
 */
export function DesignBriefForm() {
  const [state, formAction, pending] = useActionState<CreateProjectState, FormData>(createProjectAction, {});
  const [values, setValues] = useState<Values>({ projectName: "", clientName: "", designBrief: "", ideaCount: "3" });
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  const [clientErrors, setClientErrors] = useState<CreateProjectFieldErrors>({});
  const briefRef = useRef<HTMLTextAreaElement>(null);

  // Server errors win until the field is edited again.
  const errors: CreateProjectFieldErrors = { ...state.fields, ...clientErrors };
  for (const key of Object.keys(touched) as FieldName[]) if (!clientErrors[key]) delete errors[key];

  function update(name: FieldName, value: string) {
    setValues((v) => ({ ...v, [name]: value }));
    if (touched[name]) setClientErrors((e) => ({ ...e, [name]: validateField(name, value) }));
  }
  function blur(name: FieldName) {
    setTouched((t) => ({ ...t, [name]: true }));
    setClientErrors((e) => ({ ...e, [name]: validateField(name, values[name]) }));
  }

  const briefLength = values.designBrief.trim().length;

  return (
    <form
      action={formAction}
      noValidate
      onSubmit={(e) => {
        const result = createProjectSchema.safeParse(values);
        if (!result.success) {
          e.preventDefault();
          const next: CreateProjectFieldErrors = {};
          for (const issue of result.error.issues) {
            const key = issue.path[0] as FieldName;
            next[key] ??= issue.message;
          }
          setClientErrors(next);
          setTouched({ projectName: true, clientName: true, designBrief: true, ideaCount: true });
        }
      }}
      className="flex flex-col gap-8"
    >
      {state.message ? <ErrorState variant="inline" title="Couldn't create the project" message={state.message} /> : null}

      <div className="grid gap-6 sm:grid-cols-2">
        <Field id="projectName" label="Project name" error={errors.projectName}>
          <input
            id="projectName"
            name="projectName"
            value={values.projectName}
            onChange={(e) => update("projectName", e.target.value)}
            onBlur={() => blur("projectName")}
            autoComplete="off"
            maxLength={200}
            placeholder="e.g. Mechanical Wolf Bust"
            aria-invalid={errors.projectName ? true : undefined}
            aria-describedby={describedBy("projectName", errors.projectName)}
            className={cn(inputClasses, "h-12")}
          />
        </Field>
        <Field id="clientName" label="Client" error={errors.clientName}>
          <input
            id="clientName"
            name="clientName"
            value={values.clientName}
            onChange={(e) => update("clientName", e.target.value)}
            onBlur={() => blur("clientName")}
            autoComplete="organization"
            maxLength={200}
            placeholder="e.g. Northwind Collectibles"
            aria-invalid={errors.clientName ? true : undefined}
            aria-describedby={describedBy("clientName", errors.clientName)}
            className={cn(inputClasses, "h-12")}
          />
        </Field>
      </div>

      <Field
        id="designBrief"
        label="Design brief"
        error={errors.designBrief}
        hint="Describe the object, style, proportions, mood and anything it must or must not have. Plain language is perfect."
        aside={
          <span className={cn("text-caption tabular-nums", briefLength > BRIEF_MAX ? "text-danger" : "text-ink-3")}>
            {briefLength.toLocaleString()} / {BRIEF_MAX.toLocaleString()}
          </span>
        }
      >
        <div className="relative">
          <textarea
            id="designBrief"
            name="designBrief"
            ref={briefRef}
            value={values.designBrief}
            onChange={(e) => update("designBrief", e.target.value)}
            onBlur={() => blur("designBrief")}
            rows={8}
            placeholder={`e.g. “${EXAMPLE_BRIEF}”`}
            aria-invalid={errors.designBrief ? true : undefined}
            aria-describedby={describedBy("designBrief", errors.designBrief, true)}
            className={cn(inputClasses, "min-h-56 resize-y py-4 text-[1.0625rem] leading-relaxed [field-sizing:content]")}
          />
          {values.designBrief.length === 0 ? (
            <button
              type="button"
              onClick={() => {
                update("designBrief", EXAMPLE_BRIEF);
                briefRef.current?.focus();
              }}
              className="pressable absolute bottom-3 right-3 inline-flex h-8 items-center gap-1.5 rounded-full border border-hairline bg-surface-2 px-3 text-caption font-medium text-ink-2 hover:text-ink"
            >
              <Sparkles className="size-3.5" aria-hidden="true" />
              Try an example
            </button>
          ) : null}
        </div>
      </Field>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 text-callout font-medium text-ink">How many ideas?</legend>
        <div className="inline-flex w-full max-w-sm rounded-full border border-hairline-strong bg-surface p-1 sm:w-auto">
          {Array.from({ length: IDEA_COUNT_MAX - IDEA_COUNT_MIN + 1 }, (_, i) => String(IDEA_COUNT_MIN + i)).map((n) => (
            <label key={n} className="flex-1">
              <input
                type="radio"
                name="ideaCount"
                value={n}
                checked={values.ideaCount === n}
                onChange={() => update("ideaCount", n)}
                className="peer sr-only"
              />
              <span className="pressable flex h-9 min-w-14 cursor-pointer items-center justify-center rounded-full text-callout font-medium text-ink-2 peer-checked:bg-ink peer-checked:text-canvas peer-focus-visible:outline-2 peer-focus-visible:outline-accent">
                {n}
              </span>
            </label>
          ))}
        </div>
        <p className="text-caption text-ink-3">Distinct design directions to start from. You can generate more later.</p>
      </fieldset>

      <div className="flex flex-col-reverse items-stretch gap-3 border-t border-hairline pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-caption text-ink-3">Ideas usually take a few minutes. You can leave this page while they generate.</p>
        <Button type="submit" size="lg" loading={pending} icon={pending ? undefined : <Sparkles className="size-4" />}>
          {pending ? "Creating project…" : "Generate ideas"}
        </Button>
      </div>
    </form>
  );
}
