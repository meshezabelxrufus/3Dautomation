"use client";

import Image from "next/image";
import { ImageIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";

type DesignImageProps = {
  src: string | null;
  alt: string;
  /** Tailwind aspect class; square suits product/statue renders. */
  aspect?: string;
  sizes?: string;
  priority?: boolean;
  className?: string;
  /** Rendered over the image area (status overlays, badges). */
  children?: React.ReactNode;
  /** Shown instead of the generic placeholder when there is no image yet. */
  placeholder?: React.ReactNode;
};

/**
 * Image-first frame for concept and view renders. Keeps a stable aspect box so layout
 * never jumps, fades the image in once decoded, and shows a calm placeholder when
 * there is no image yet or it fails to load.
 */
export function DesignImage({
  src,
  alt,
  aspect = "aspect-square",
  sizes = "(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw",
  priority,
  className,
  children,
  placeholder,
}: DesignImageProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const showImage = src && !failed;

  return (
    <div className={cn("relative overflow-hidden rounded-[var(--radius-image)] bg-sunken", aspect, className)}>
      {showImage ? (
        <Image
          src={src}
          alt={alt}
          fill
          sizes={sizes}
          priority={priority}
          unoptimized
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn(
            "object-cover transition-opacity duration-300 ease-out motion-reduce:transition-none",
            loaded ? "opacity-100" : "opacity-0",
          )}
        />
      ) : placeholder && !src ? (
        <div className="absolute inset-0">{placeholder}</div>
      ) : (
        <div className="absolute inset-0 grid place-items-center text-ink-3" aria-hidden={!failed}>
          <ImageIcon className="size-7 opacity-50" strokeWidth={1.5} />
          {failed ? <span className="sr-only">Image unavailable</span> : null}
        </div>
      )}
      {children}
    </div>
  );
}
