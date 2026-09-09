"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@repo/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/ui/card";
import { Input } from "@repo/ui/components/ui/input";
import { Label } from "@repo/ui/components/ui/label";
import { Skeleton } from "@repo/ui/components/ui/skeleton";
import Link from "next/link";
import {
  AlertCircle,
  ChevronRight,
  Fingerprint,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  appUrl,
  authClient,
  DEFAULT_AUTH_CONFIG,
  fetchAuthConfig,
  type AuthConfig,
} from "@/lib/auth-client";
import { formatDate, toEpochMs } from "@/components/account/format";

/** better-auth files a password credential under this provider id. */
const PASSWORD_PROVIDER = "credential";

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
};

const label = (id: string) => PROVIDER_LABELS[id] ?? id;

type PasskeyRow = {
  id: string;
  name?: string | undefined;
  createdAt: Date;
};

type AccountRow = { accountId: string; providerId: string };

export function SecurityPanel() {
  const [config, setConfig] = useState<AuthConfig>(DEFAULT_AUTH_CONFIG);
  const [passkeys, setPasskeys] = useState<PasskeyRow[] | null>(null);
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  /**
   * Distinct from `error`, and it has to be.
   *
   * `error` is "that action failed". This is "we do not know what your sign-in
   * methods are" — and the difference matters because the fallback for an
   * unknown list used to be the *empty* list, so a failed fetch rendered "No
   * passkeys yet" under a red banner. That is not a degraded state; it is a
   * false statement about the credentials guarding the account, and the obvious
   * reaction to it is to add a passkey you already have.
   */
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    const [keys, linked] = await Promise.all([
      authClient.passkey.listUserPasskeys(),
      authClient.listAccounts(),
    ]);
    setPasskeys(
      (keys.data ?? []).map((k) => ({
        id: k.id,
        name: k.name,
        createdAt: k.createdAt,
      })),
    );
    setAccounts(
      (linked.data ?? []).map((a) => ({
        accountId: a.accountId,
        providerId: a.providerId,
      })),
    );
  }, []);

  /** The retry the error banner never had — it was a dead end with no way out. */
  const reload = useCallback(async () => {
    setLoadFailed(false);
    setPasskeys(null);
    setAccounts(null);
    setError(null);
    try {
      await load();
    } catch {
      setError("Could not load your sign-in methods.");
      setLoadFailed(true);
    }
  }, [load]);

  useEffect(() => {
    void fetchAuthConfig().then(setConfig);
    void reload();
  }, [reload]);

  const hasPassword =
    accounts?.some((a) => a.providerId === PASSWORD_PROVIDER) ?? false;
  const social = (accounts ?? []).filter(
    (a) => a.providerId !== PASSWORD_PROVIDER,
  );
  const passkeyCount = passkeys?.length ?? 0;

  /**
   * How many ways into this account survive removing one credential.
   *
   * **The API does not check this.** better-auth will happily delete your only
   * passkey, and `unlinkAccount` only guards against removing the last *account*
   * row — a notion that does not count passkeys at all, because they live in
   * their own table. So the guard lives here, in the one place that can see
   * every method at once. It is a UI guard and nothing more: someone determined
   * enough to call the endpoint directly can still lock themselves out.
   *
   * The cost of getting it wrong is not "an error message" — it is an account
   * with no way in, and mtmux has no support desk to undo that.
   */
  function remaining(kind: "passkey" | "social"): number {
    const passwords = hasPassword ? 1 : 0;
    if (kind === "passkey") return passwords + social.length + passkeyCount - 1;
    return passwords + passkeyCount + social.length - 1;
  }

  async function guard(key: string, run: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await run();
    } catch {
      setError("Could not reach mtmux. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  async function addPasskey() {
    await guard("add", async () => {
      const result = await authClient.passkey.addPasskey({
        // A name is optional; an empty string would be stored verbatim, so it
        // is normalised to "this device" here rather than in the database.
        name: newName.trim() || "This device",
      });
      if (result?.error) {
        setError(result.error.message ?? "Could not add that passkey.");
        return;
      }
      setNewName("");
      toast.success("Passkey added.");
      await load();
    });
  }

  async function removePasskey(row: PasskeyRow) {
    if (remaining("passkey") < 1) {
      setError(
        "That's your only way to sign in. Set a password or connect an " +
          "account first, then remove this passkey.",
      );
      return;
    }
    await guard(`del:${row.id}`, async () => {
      const result = await authClient.passkey.deletePasskey({ id: row.id });
      if (result?.error) {
        setError(result.error.message ?? "Could not remove that passkey.");
        return;
      }
      toast.success("Passkey removed.");
      await load();
    });
  }

  async function link(provider: string) {
    await guard(`link:${provider}`, async () => {
      await authClient.linkSocial({
        provider: provider as "google" | "github",
        // Absolute, or it resolves against the API's origin rather than this
        // app's and lands on a host that serves no pages.
        callbackURL: appUrl("/settings/security"),
      });
    });
  }

  async function unlink(row: AccountRow) {
    if (remaining("social") < 1) {
      setError(
        "That's your only way to sign in. Set a password or add a passkey " +
          "first, then disconnect this account.",
      );
      return;
    }
    await guard(`unlink:${row.providerId}`, async () => {
      const result = await authClient.unlinkAccount({
        providerId: row.providerId,
        accountId: row.accountId,
      });
      if (result?.error) {
        setError(result.error.message ?? "Could not disconnect that account.");
        return;
      }
      toast.success(`${label(row.providerId)} disconnected.`);
      await load();
    });
  }

  // `loadFailed` ends the loading state as surely as data does — otherwise a
  // failed fetch leaves `passkeys` null and the skeleton spins forever.
  const loading = !loadFailed && (passkeys === null || accounts === null);

  return (
    <div className="space-y-6">
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{error}</span>
          {/* Only on the load failure. An action failure is retried by doing
              the action again, and a Retry beside it would be ambiguous about
              which of the two it meant. */}
          {loadFailed && (
            <Button
              variant="outline"
              className="h-11 shrink-0"
              onClick={() => void reload()}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Try again
            </Button>
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Fingerprint className="h-4 w-4 text-primary" aria-hidden />
            Passkeys
          </CardTitle>
          <CardDescription>
            Sign in with your fingerprint, face or device PIN. Nothing to type,
            nothing to leak.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/*
            Three states where there used to be two.

            A skeleton rather than a bare spinner: the old one was a 16px
            `Loader2` with no text and no `role`, which announces nothing and
            gives a sighted reader no idea what shape is coming.

            And `loadFailed` renders **nothing**. It used to fall through to the
            empty case, so a failed fetch said "No passkeys yet" under a red
            banner — a false statement about the credentials guarding the
            account, whose obvious remedy is to enrol a passkey you already
            have. The banner above says what happened and offers the retry.
          */}
          {loading ? (
            <div className="space-y-2" aria-hidden>
              <Skeleton className="h-14 w-full rounded-md" />
              <Skeleton className="h-14 w-full rounded-md" />
              <span className="sr-only" role="status">
                Loading your sign-in methods
              </span>
            </div>
          ) : loadFailed ? null : (passkeys ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No passkeys yet.</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {(passkeys ?? []).map((row) => (
                <li
                  key={row.id}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-foreground">
                      {row.name || "Passkey"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Added {formatDate(toEpochMs(row.createdAt))}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 shrink-0"
                    aria-label={`Remove ${row.name || "passkey"}`}
                    disabled={busy !== null}
                    onClick={() => void removePasskey(row)}
                  >
                    {busy === `del:${row.id}` ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    ) : (
                      <Trash2 className="h-4 w-4" aria-hidden />
                    )}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            hidden={loading || loadFailed}
          >
            <div className="flex-1 space-y-2">
              <Label htmlFor="passkey-name">Name this device</Label>
              <Input
                id="passkey-name"
                className="h-11"
                placeholder="This device"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                disabled={busy !== null}
              />
            </div>
            <Button
              className="h-11"
              disabled={busy !== null}
              onClick={() => void addPasskey()}
            >
              {busy === "add" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Plus className="h-4 w-4" aria-hidden />
              )}
              Add a passkey
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Hidden while the account list is unknown: with `accounts` null every
          provider would render a "Connect" button, including ones that are
          already connected. Same lie as "No passkeys yet", one card down. */}
      {config.providers.length > 0 && !loadFailed && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Link2 className="h-4 w-4 text-primary" aria-hidden />
              Connected accounts
            </CardTitle>
            <CardDescription>
              Sign in with an account you already have.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border rounded-md border border-border">
              {config.providers.map((provider) => {
                const linked = social.find((a) => a.providerId === provider);
                return (
                  <li
                    key={provider}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <span className="text-sm text-foreground">
                      {label(provider)}
                    </span>
                    {linked ? (
                      <Button
                        variant="outline"
                        className="h-11"
                        disabled={busy !== null}
                        onClick={() => void unlink(linked)}
                      >
                        {busy === `unlink:${provider}` ? (
                          <Loader2
                            className="h-4 w-4 animate-spin"
                            aria-hidden
                          />
                        ) : null}
                        Disconnect
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        className="h-11"
                        disabled={busy !== null}
                        onClick={() => void link(provider)}
                      >
                        {busy === `link:${provider}` ? (
                          <Loader2
                            className="h-4 w-4 animate-spin"
                            aria-hidden
                          />
                        ) : null}
                        Connect
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
            {/* No avatars anywhere on this page, deliberately: rendering one
                needs `img-src` widened to Google's and GitHub's CDNs in
                `proxy.ts`, and the header already shows the email. */}
          </CardContent>
        </Card>
      )}

      {/*
        The other half of "security", and it is not on this page.

        The device PIN, the erase-after-ten-wrong-attempts toggle and "Erase
        this device" all live at `/settings` — device state, not account state,
        which is why they are a separate route. A card rather than a fourth item
        in the header nav: the bar already has to fit three links, an email and
        sign-out inside 390px, and this is a page you visit once.
      */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <SlidersHorizontal className="h-4 w-4 text-primary" aria-hidden />
            This device
          </CardTitle>
          <CardDescription>
            The PIN that locks this browser, what an erase does, and the
            terminal&apos;s own settings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" className="h-11 w-full sm:w-auto">
            <Link href="/settings">
              Device settings
              <ChevronRight className="h-4 w-4" aria-hidden />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
