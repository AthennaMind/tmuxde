/** Shared loading view for file reads and editor startup. */
export function FileLoading() {
  return (
    <div role="status" className="h-full space-y-2 bg-background p-4">
      <span className="sr-only">Loading file</span>
      {[72, 48, 64, 40, 80, 56, 44, 68, 52, 76, 40, 60].map((width, index) => (
        <div
          key={index}
          aria-hidden
          className="h-4 rounded bg-muted motion-safe:animate-pulse"
          style={{ width: `${width}%` }}
        />
      ))}
    </div>
  );
}
