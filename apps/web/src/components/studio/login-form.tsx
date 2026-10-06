"use client";

import { LogIn } from "lucide-react";
import { useActionState, useId } from "react";
import { loginAction, type LoginState } from "@/app/login/actions";
import { Button } from "@/components/ui/button";
import { inputClasses } from "@/components/ui/field";
import { cn } from "@/lib/cn";

export function LoginForm({ next }: { next: string }) {
  const id = useId();
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <div className="flex flex-col gap-2">
        <label htmlFor={id} className="text-callout font-medium text-ink">
          Password
        </label>
        <input
          id={id}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? `${id}-error` : undefined}
          className={cn(inputClasses, "h-11")}
        />
        {state.error ? (
          <p id={`${id}-error`} role="alert" className="text-caption text-danger">
            {state.error}
          </p>
        ) : null}
      </div>
      <Button type="submit" size="lg" loading={pending} icon={<LogIn className="size-4" />}>
        Sign in
      </Button>
    </form>
  );
}
