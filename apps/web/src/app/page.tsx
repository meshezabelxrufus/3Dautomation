// Placeholder only. Milestone 1 UI is built in later steps.
export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold tracking-tight">3D Design Studio</h1>
        <p className="mt-2 text-sm opacity-70">
          Infrastructure is running. Service status: <a className="underline" href="/api/health">/api/health</a>
        </p>
      </div>
    </main>
  );
}
