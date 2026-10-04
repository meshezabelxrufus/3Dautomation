/**
 * A real CSS 3D object (no image): three lit metal hoops on different axes around a
 * glowing core, over a perspective floor grid. Rotation periods are long (48–90 s);
 * under reduced motion the global rule freezes them in a pleasing pose.
 */
const ring =
  "absolute inset-0 rounded-full [mask:radial-gradient(farthest-side,transparent_calc(100%-3px),#000_calc(100%-2.5px))]";

export function Gyroscope() {
  return (
    <div className="relative aspect-square w-full [transform-style:preserve-3d]" aria-hidden="true">
      {/* Floor: a perspective grid fading into the dark, like a 3D viewport. */}
      <div
        className="pointer-events-none absolute inset-x-[-40%] bottom-[-18%] h-[70%] [transform:rotateX(76deg)] opacity-40 [mask-image:radial-gradient(ellipse_at_center,#000_15%,transparent_68%)]"
        style={{
          backgroundImage:
            "linear-gradient(rgb(255 255 255 / 0.14) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255 / 0.14) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
        }}
      />
      {/* Light pooled under the object. */}
      <div className="absolute bottom-[4%] left-1/2 h-[10%] w-[55%] -translate-x-1/2 rounded-[50%] bg-[#2997ff]/25 blur-2xl" />

      <div className="absolute inset-[5%] [transform-style:preserve-3d] [transform:rotateX(-14deg)_rotateY(24deg)]">
        {/* Outer hoop: slow turn around Y. */}
        <div className="absolute inset-0 [transform-style:preserve-3d] [animation:spin-y_64s_linear_infinite]">
          <div
            className={ring}
            style={{
              background:
                "conic-gradient(from 210deg, rgb(255 255 255 / 0.15), rgb(255 255 255 / 0.85) 18%, rgb(170 205 255 / 0.35) 40%, rgb(255 255 255 / 0.12) 62%, rgb(255 214 170 / 0.7) 82%, rgb(255 255 255 / 0.15))",
            }}
          />
        </div>
        {/* Middle hoop: tipped 90°, turning around X. */}
        <div className="absolute inset-[9%] [transform-style:preserve-3d] [transform:rotateY(90deg)]">
          <div className="absolute inset-0 [transform-style:preserve-3d] [animation:spin-x_48s_linear_infinite]">
            <div
              className={ring}
              style={{
                background:
                  "conic-gradient(from 40deg, rgb(255 255 255 / 0.1), rgb(160 200 255 / 0.75) 25%, rgb(255 255 255 / 0.2) 50%, rgb(255 255 255 / 0.9) 70%, rgb(255 255 255 / 0.1))",
              }}
            />
          </div>
        </div>
        {/* Inner hoop: on the equator, turning around Z. */}
        <div className="absolute inset-[19%] [transform-style:preserve-3d] [transform:rotateX(90deg)]">
          <div className="absolute inset-0 [animation:spin-z_90s_linear_infinite]">
            <div
              className={ring}
              style={{
                background:
                  "conic-gradient(from 120deg, rgb(255 255 255 / 0.08), rgb(255 255 255 / 0.7) 30%, rgb(255 200 150 / 0.45) 55%, rgb(255 255 255 / 0.08) 80%)",
              }}
            />
          </div>
        </div>
        {/* Core: a lit sphere with a soft bloom. */}
        <div className="absolute inset-[37%] rounded-full bg-[#2997ff]/40 blur-2xl" />
        <div
          className="absolute inset-[39%] rounded-full shadow-[0_0_60px_10px_rgb(41_151_255/0.35)]"
          style={{
            background:
              "radial-gradient(circle at 34% 28%, #ffffff 0%, #cfe4ff 14%, #4f9bff 38%, #1a3f8f 66%, #08142c 100%)",
          }}
        />
      </div>
    </div>
  );
}
