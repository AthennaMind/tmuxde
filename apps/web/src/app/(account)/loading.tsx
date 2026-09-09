import { Skeleton } from "@repo/ui/components/ui/skeleton";

/**
 * The shape of an account page, while its chunk is still arriving.
 *
 * A skeleton and not a spinner, for the reason the dashboard's own skeletons
 * exist: the page that follows is a heading and a stack of cards, so a preview
 * of that shape means the first real paint does not jump.
 *
 * `role="status"` on the wrapper rather than on each block, so a screen reader
 * hears "Loading" once instead of narrating five grey rectangles.
 */
export default function AccountLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-8">
      <div aria-hidden>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-2 h-4 w-full max-w-md" />
        <div className="mt-6 space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-lg border border-border">
              <div className="border-b border-border px-4 py-3">
                <Skeleton className="h-4 w-40" />
              </div>
              <div className="space-y-3 p-4">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-5 w-24" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <span className="sr-only" role="status">
        Loading
      </span>
    </div>
  );
}
