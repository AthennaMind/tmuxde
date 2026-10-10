"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@repo/ui/components/ui/button";
import { ConnectPanel } from "@/components/entry/connect-panel";
import { takeBounce } from "@/lib/bounce-guard";

export default function StartPage() {
  const [bounced, setBounced] = useState(false);
  useEffect(() => setBounced(takeBounce()), []);

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-10">
      {bounced && (
        <div
          className="rounded-lg border border-border bg-muted/40 p-4 text-sm"
          role="status"
        >
          <p>That session is no longer usable.</p>
          <p className="mt-1 text-muted-foreground">
            Enter a fresh code or reconnect with your relay token.
          </p>
        </div>
      )}
      <ConnectPanel variant="full" />
      <div className="flex items-center justify-between gap-3 border-t border-border pt-5 text-sm">
        <span className="text-muted-foreground">Have a relay token?</span>
        <Button asChild variant="outline" size="sm" className="h-9 shrink-0">
          <Link href="/login">Use a token</Link>
        </Button>
      </div>
    </div>
  );
}
