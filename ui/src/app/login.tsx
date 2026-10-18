import { useState, useRef, useCallback, useEffect } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { RelayClient } from "@/features/connection/ws-client";
import { resolveRelayWsUrl } from "@/features/connection/relay-url";
import { TOKEN_KEY, clearStored, writeStored } from "@/features/connection/storage-keys";

/** Connect to the server with its token. */
export function LoginPage() {
  const navigate = useNavigate();
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
          "No relay answered on this origin. Check that your local Docker stack is running.",
        );
      }, 5000);

      const loginUrl = new URL(resolveRelayWsUrl());
      loginUrl.searchParams.set("machine", "hub");
      const client = new RelayClient({
        url: loginUrl.toString(),
        token: trimmedToken,
        onMessage: (msg) => {
          if (msg.type === "auth:success") {
            clearTimeout(timeoutId);
            // Clear ref BEFORE disconnect to prevent the status handler
            // from treating this intentional disconnect as a failure
            clientRef.current = null;
            client.disconnect();
            navigate("/");
          } else if (msg.type === "auth:failure") {
            clearTimeout(timeoutId);
            clientRef.current = null;
            client.disconnect();
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
    [navigate],
  );

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!token.trim()) {
      toast.error("Please enter a token");
      return;
    }
    connectWithToken(token.trim());
  }

  // Auto-login from a `#token=<64 hex>` link. The fragment is never sent to
  // the server and is stripped from the URL before anything else happens.
  // Without it, the manual paste form below is the fallback.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const hashToken = params.get("token")?.trim();
    if (!hashToken) return;

    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    connectWithToken(hashToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-10">
      <div className="space-y-1 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Connect with a token</h1>
        <p className="text-sm text-muted-foreground">Use AUTH_TOKEN configured on your server.</p>
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
        <Button className="h-11 w-full" type="submit" disabled={isLoading} aria-busy={isLoading}>
          {isLoading ? "Connecting…" : "Connect"}
        </Button>
      </form>
    </div>
  );
}
