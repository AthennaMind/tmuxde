"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@repo/ui/components/ui/button";
import { Input } from "@repo/ui/components/ui/input";
import { Label } from "@repo/ui/components/ui/label";
import { toast } from "sonner";
import { RelayClient } from "@/lib/ws-client";
import { resolveRelayWsUrl } from "@/lib/relay-url";
import { redeemLocalPairingNonce } from "@/lib/local-pairing";
import { hydrateDescriptor } from "@/lib/session-store";
import {
  TOKEN_KEY,
  readSelfHostedToken,
  clearStored,
  writeStored,
} from "@/lib/storage-keys";

/**
 * The self-hosted path: paste the relay token `mtmux start` printed.
 *
 * This is **not** the front door, and it used to be — `/` sent every visitor
 * with no session here, including the majority who have a pairing code and no
 * token at all. Typing a pairing code into this form opened a socket to
 * `/_relay` on whatever origin served the page, which on app.mtmux.com is
 * nothing, and hung until it timed out. `/start` is the front door now; this
 * page is reached from a link there, or directly by the CLI's own `#token=`
 * and `#n=` handoffs.
 */
export default function LoginPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const clientRef = useRef<RelayClient | null>(null);

  // Validate a token by attempting a WebSocket connection, then redirect on
  // success. Shared by the manual paste form and fragment-based auto-login.
  const connectWithToken = useCallback(
    (trimmedToken: string) => {
      setIsLoading(true);

      // Store token first
      writeStored(TOKEN_KEY, trimmedToken);

      // Validate by attempting a WebSocket connection
      const timeoutId = setTimeout(() => {
        clientRef.current?.disconnect();
        clientRef.current = null;
        clearStored(TOKEN_KEY);
        setIsLoading(false);
        toast.error(
          "No relay answered on this origin. If you have a pairing code, use Connect with a code instead.",
        );
      }, 5000);

      const client = new RelayClient({
        url: resolveRelayWsUrl(),
        token: trimmedToken,
        onMessage: (msg) => {
          if (msg.type === "auth:success") {
            clearTimeout(timeoutId);
            // Clear ref BEFORE disconnect to prevent the status handler
            // from treating this intentional disconnect as a failure
            clientRef.current = null;
            client.disconnect();
            router.push("/");
            router.refresh();
          } else if (msg.type === "auth:failure") {
            clearTimeout(timeoutId);
            clientRef.current = null;
            client.disconnect();
            /*
             * A refusal is not a bad token, and this used to throw away a
             * perfectly good one for it.
             *
             * Every connection is now put to a human at the machine, so "no"
             * and "nobody reached the keyboard in time" are ordinary answers
             * on a token that is in perfect health. Wiping it here meant the
             * form came back empty and the person had to go and find the
             * token again because somebody was slow — punishing the user for
             * the machine's caution.
             */
            if (msg.code === "unapproved") {
              setIsLoading(false);
              toast.error(
                "Not approved on the machine. Say yes there, then try again.",
              );
              return;
            }
            clearStored(TOKEN_KEY);
            setIsLoading(false);
            toast.error(msg.reason || "Authentication failed");
          }
        },
        onStatusChange: (status) => {
          if (status === "disconnected" && clientRef.current) {
            clearTimeout(timeoutId);
            clientRef.current = null;
            clearStored(TOKEN_KEY);
            setIsLoading(false);
            toast.error("Failed to connect to relay server");
          }
        },
      });

      clientRef.current = client;
      client.connect();
    },
    [router],
  );

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!token.trim()) {
      toast.error("Please enter a token");
      return;
    }
    connectWithToken(token.trim());
  }

  // Auto-login from the URL fragment (never sent to the server, never logged).
  // Two shapes, both stripped from the URL before anything else happens:
  //
  //   #token=<64 hex>  the CLI's own auto-open on this machine
  //   #n=<nonce>       a QR scan from a phone — redeemed for a scoped session
  //                    token so the long-lived AUTH_TOKEN is never typed or
  //                    transmitted to the device
  //
  // With neither, the manual paste form below is the fallback.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const hashToken = params.get("token")?.trim();
    const pairingNonce = params.get("n")?.trim();

    if (!hashToken && !pairingNonce) {
      // No credential in the URL, but a previous hosted pairing may still be
      // on this device: the keys and the connection descriptor both live in
      // IndexedDB and outlive the tab. The terminal reads the descriptor
      // synchronously and sent us here because its sessionStorage mirror was
      // empty, so refilling it is the whole of "restore my session".
      if (readSelfHostedToken()) return;
      setIsLoading(true);
      void hydrateDescriptor().then((session) => {
        setIsLoading(false);
        if (session) router.replace("/");
      });
      return;
    }

    // Remove the fragment from the URL before doing anything else.
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );

    if (hashToken) {
      connectWithToken(hashToken);
      return;
    }

    setIsLoading(true);
    redeemLocalPairingNonce(pairingNonce!)
      .then(({ token: sessionToken }) => connectWithToken(sessionToken))
      .catch((err: Error) => {
        setIsLoading(false);
        toast.error(err.message);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-10">
      <div className="space-y-1 text-center">
        <h1 className="text-xl font-semibold tracking-tight">
          Connect with a token
        </h1>
        <p className="text-sm text-muted-foreground">
          The self-hosted path. Use the long token <code>mtmux start</code>{" "}
          printed on the machine itself.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="token">Relay token</Label>
          <Input
            id="token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="64 hex characters"
            autoComplete="off"
            autoFocus
          />
        </div>
        <Button
          className="h-11 w-full"
          type="submit"
          disabled={isLoading}
          aria-busy={isLoading}
        >
          {isLoading ? "Connecting…" : "Connect"}
        </Button>
      </form>

      {/* The way out. This page used to have none, which is how someone who
          arrived here with a pairing code and no token got stuck. */}
      <div className="space-y-2 border-t border-border pt-5 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Have a pairing code?</span>
          <Button asChild variant="outline" size="sm" className="h-9 shrink-0">
            <Link href="/start">Connect with a code</Link>
          </Button>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">
            Already have an account?
          </span>
          <Button asChild variant="ghost" size="sm" className="h-9 shrink-0">
            <Link href="/signin">Sign in</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
