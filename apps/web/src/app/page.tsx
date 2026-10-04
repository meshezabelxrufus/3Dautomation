import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { ArrowRight, Sparkles } from "lucide-react";
import { Gyroscope } from "@/components/welcome/gyroscope";
import { Materialize } from "@/components/welcome/materialize";
import { TimeGreeting } from "@/components/welcome/time-greeting";
import { ContinueCard, QuoteCard, StatTile } from "@/components/welcome/welcome-panels";
import { WelcomeStage } from "@/components/welcome/welcome-stage";
import { getDb } from "@/lib/server/db";
import { quoteOfTheDay } from "@/lib/quotes";
import { getStudioSummary, type StudioSummaryDTO } from "@/server/queries/projects";

export const metadata: Metadata = { title: "Welcome" };

// Until accounts exist (later step), the studio greets its owner by name.
const GREETING_NAME = process.env.STUDIO_GREETING_NAME ?? "Rafey";

function headline(s: StudioSummaryDTO): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (s.needsReview > 0) return `${plural(s.needsReview, "design is", "designs are")} waiting for your eye.`;
  if (s.inProgress > 0) return `${plural(s.inProgress, "design is", "designs are")} taking shape right now.`;
  if (s.total === 0) return "Describe your first idea and the studio will sketch the directions.";
  return "Everything is up to date. What should we make next?";
}

export default async function WelcomePage() {
  await connection();
  const summary = await getStudioSummary(getDb());
  const quote = quoteOfTheDay();

  return (
    <WelcomeStage object={<Gyroscope />}>
      {/* Greeting */}
      <div className="order-1 flex flex-col gap-6 lg:order-none lg:col-span-7 lg:row-start-1 lg:pt-6">
        <TimeGreeting className="text-[0.9375rem] font-medium tracking-[0.01em] text-white/55" />
        <h1 className="text-[clamp(3.25rem,1.6rem+7vw,7rem)] leading-[0.92] tracking-[-0.05em]">
          <span className="font-medium text-white/50">Welcome,</span>
          <br />
          <span className="font-semibold text-white">{GREETING_NAME}.</span>
        </h1>
        <p className="max-w-md text-[1.125rem] leading-relaxed tracking-[-0.005em] text-white/70">{headline(summary)}</p>
        <div className="flex flex-wrap gap-3 pt-2">
          <Link
            href="/projects/new"
            className="pressable inline-flex h-12 items-center gap-2 rounded-full bg-white px-6 text-[1rem] font-semibold text-black hover:bg-white/90"
          >
            <Sparkles className="size-4" aria-hidden="true" />
            Start a new design
          </Link>
          <Link
            href="/projects"
            className="glass-thin pressable inline-flex h-12 items-center gap-2 rounded-full px-6 text-[1rem] font-medium text-white hover:bg-white/[0.1]"
          >
            Open projects
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </div>

      {/* Studio at a glance */}
      <Materialize delay={0.1} className="order-4 grid grid-cols-3 gap-3 lg:order-none lg:col-span-6 lg:row-start-2 lg:self-end">
        <StatTile value={summary.needsReview} label="Waiting for you" tone="review" href="/projects" />
        <StatTile value={summary.inProgress} label="In the works" tone="working" href="/projects" />
        <StatTile value={summary.delivered} label="Delivered" tone="done" href="/projects" />
      </Materialize>

      {/* Continue + quote: the quote's glass floats over the object so you see it through the material. */}
      <Materialize delay={0.2} className="order-5 lg:order-none lg:col-span-6 lg:row-start-3">
        <ContinueCard project={summary.continueWith} />
      </Materialize>
      <Materialize delay={0.3} className="relative z-10 order-3 -mt-28 sm:-mt-36 lg:order-none lg:col-span-6 lg:col-start-7 lg:row-start-3 lg:-mt-44">
        <QuoteCard quote={quote} />
      </Materialize>
    </WelcomeStage>
  );
}
