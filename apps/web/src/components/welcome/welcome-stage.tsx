"use client";

import { motion, useMotionTemplate, useMotionValue, useReducedMotion, useSpring, useTransform } from "motion/react";
import type { PointerEvent, ReactNode } from "react";

// Apple "move" spring: critically damped (no overshoot), ~0.4 s response.
const MOVE = { bounce: 0, visualDuration: 0.4 } as const;

/**
 * The dark studio scene. The pointer drives a soft key light and tilts the 3D object
 * through springs, so motion always continues from where it is and can be redirected
 * mid-flight. No tilt for touch input or reduced motion.
 */
export function WelcomeStage({ object, children }: { object: ReactNode; children: ReactNode }) {
  const reduce = useReducedMotion();
  const px = useMotionValue(0.5);
  const py = useMotionValue(0.35);
  const sx = useSpring(px, MOVE);
  const sy = useSpring(py, MOVE);
  const rotateY = useTransform(sx, [0, 1], [-16, 16]);
  const rotateX = useTransform(sy, [0, 1], [12, -12]);
  const lightX = useTransform(sx, (v) => `${v * 100}%`);
  const lightY = useTransform(sy, (v) => `${v * 100}%`);
  const keyLight = useMotionTemplate`radial-gradient(42rem circle at ${lightX} ${lightY}, rgb(255 255 255 / 0.075), transparent 60%)`;

  function onPointerMove(e: PointerEvent<HTMLElement>) {
    if (reduce || e.pointerType === "touch") return;
    const r = e.currentTarget.getBoundingClientRect();
    px.set((e.clientX - r.left) / r.width);
    py.set((e.clientY - r.top) / r.height);
  }
  function onPointerLeave() {
    px.set(0.5);
    py.set(0.35);
  }

  return (
    <section
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      className="grain relative overflow-hidden rounded-[2rem] bg-[#05070b] text-white [color-scheme:dark] sm:rounded-[2.5rem]"
    >
      {/* Studio lighting: a cool softbox from above, a warm rim from the right, and a key light that follows the pointer. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute inset-x-0 top-[-30%] h-[80%] bg-[radial-gradient(60%_60%_at_50%_0%,rgb(120_170_255/0.22),transparent_70%)]" />
        <div className="absolute right-[-10%] top-[20%] h-[70%] w-[50%] bg-[radial-gradient(closest-side,rgb(255_170_110/0.12),transparent)]" />
        <motion.div className="absolute inset-0" style={{ backgroundImage: keyLight }} />
      </div>

      <div className="relative grid gap-10 p-5 sm:p-8 lg:grid-cols-12 lg:gap-6 lg:p-12">
        {children}
        <div className="relative order-2 mx-auto w-full max-w-[22rem] [perspective:1100px] sm:max-w-[26rem] lg:order-none lg:col-span-5 lg:col-start-8 lg:row-span-2 lg:row-start-1 lg:max-w-none lg:self-center">
          <motion.div style={reduce ? undefined : { rotateX, rotateY }} className="[transform-style:preserve-3d]">
            {object}
          </motion.div>
        </div>
      </div>
    </section>
  );
}
