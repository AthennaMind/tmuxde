import Link from "next/link";
import { Terminal } from "lucide-react";

/** Header for local connection pages. */
export function EntryHeader() {
  return (
    <header className="border-b border-border pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex h-14 w-full max-w-3xl items-center px-4">
        <Link
          href="/start"
          className="flex items-center gap-2 rounded-md py-2 pr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10">
            <Terminal className="h-4 w-4 text-primary" aria-hidden />
          </span>
          <span className="font-mono text-sm font-semibold tracking-tight">
            tmuxde
          </span>
        </Link>
      </div>
    </header>
  );
}
