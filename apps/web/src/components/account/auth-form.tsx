"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { WebAuthnAbortService } from "@simplewebauthn/browser";
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
import { cn } from "@repo/ui/lib/utils";
import {
  AlertCircle,
  ArrowLeft,
  Fingerprint,
  Loader2,
  Mail,
  MailCheck,
  Terminal,
} from "lucide-react";
import {
  appUrl,
  authClient,
  DEFAULT_AUTH_CONFIG,
  fetchAuthConfig,
  isHostedBuild,
  lookupAccount,
  signIn,
  signUp,
  useSession,
  type AccountLookup,
  type AuthConfig,
} from "@/lib/auth-client";
import { markOnboardingStarted } from "@/hooks/use-onboarding";
import { HostedUnavailable } from "./hosted-unavailable";
import { safeNext } from "./format";

type Mode = "signin" | "signup";

/**
 * The state machine.
 *
 * `email` is the only entry point people type into. What comes after it is
 * decided by the broker, not by which page they landed on: an address that has
 * an account goes to `signin` — showing only the methods that address actually
 * has — and one that does not goes to `signup` with the address carried over
 * and read-only. `magic-sent` and `reset-sent` are terminal; there is nothing
 * useful to do in the tab once the mail is out.
 */
type Step = "email" | "signin" | "signup" | "magic-sent" | "reset-sent";

type Fields = { name: string; email: string; password: string };
type FieldErrors = Partial<Record<keyof Fields, string>>;

// Deliberately loose. The authority on whether an address exists is the
// verification mail, not a regex, and a strict pattern only ever rejects
// somebody's perfectly valid address.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
};

function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id;
}

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, isPending } = useSession();

  const next = useMemo(
    () => safeNext(searchParams.get("next")),
    [searchParams],
  );
  const presetEmail = useMemo(
    () => (searchParams.get("email") ?? "").trim(),
    [searchParams],
  );
  const errorParam = searchParams.get("error");

  const [step, setStep] = useState<Step>(() =>
    // `/signup?email=…` as a hard navigation lands straight on the sign-up
    // form, with the address already filled in. Nothing in the CLI prints such
    // a link — an earlier comment here claimed it did, and
    // `grep -rn "/signup" apps/cli apps/api` is empty — but the site's pricing
    // page and the terminal's account nudge both link here, and re-asking for
    // an address that was just handed over reads as a bug.
    mode === "signup" && presetEmail ? "signup" : "email",
  );
  const [fields, setFields] = useState<Fields>({
    name: "",
    email: presetEmail,
    password: "",
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(() =>
    errorParam === "account_not_linked"
      ? "You already have an account for this email. Sign in below, then " +
        "connect that provider in Settings."
      : null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [lookup, setLookup] = useState<AccountLookup | null>(null);
  const [config, setConfig] = useState<AuthConfig>(DEFAULT_AUTH_CONFIG);

  // Someone who is already signed in should never be shown a sign-in form —
  // most often they arrived here from a /device link in a second tab.
  useEffect(() => {
    if (!isHostedBuild || isPending || !session) return;
    router.replace(next);
  }, [isPending, session, router, next]);

  useEffect(() => {
    if (!isHostedBuild) return;
    let live = true;
    void fetchAuthConfig().then((result) => {
      if (live) setConfig(result);
    });
    return () => {
      live = false;
    };
  }, []);

  const finish = useCallback(() => {
    router.replace(next);
    router.refresh();
  }, [router, next]);

  const resolveEmail = useCallback(
    async (email: string) => {
      setBusy("lookup");
      setFormError(null);
      try {
        const result = await lookupAccount(email);
        setLookup(result);
        setStep(result.exists ? "signin" : "signup");
        if (result.exists && mode === "signup") {
          setNotice("You already have an account for this address.");
        }
      } catch {
        // A lookup that cannot be reached must not be a dead end. Fall through
        // to whichever form the page was asked for and let the real call fail
        // with a real message.
        setLookup(null);
        setStep(mode === "signup" ? "signup" : "signin");
      } finally {
        setBusy(null);
      }
    },
    [mode],
  );

  // `/signin?email=…` — the landing spot for the `account_not_linked` bounce —
  // should already be on the sign-in step by the time it is read.
  const resolved = useRef(false);
  useEffect(() => {
    if (resolved.current) return;
    if (mode !== "signin" || !presetEmail || !EMAIL.test(presetEmail)) return;
    resolved.current = true;
    void resolveEmail(presetEmail);
  }, [mode, presetEmail, resolveEmail]);

  /**
   * Conditional UI ("passkey autofill").
   *
   * The browser offers a stored passkey from the email field's own autofill
   * dropdown, with no button to press. Two things make it work: the
   * `webauthn` token in the input's `autoComplete`, and a ceremony already
   * running in the background when the field is focused.
   *
   * The cleanup is not optional. A conditional ceremony outlives the element
   * it was attached to, and Safari in particular leaves the prompt on screen
   * — attached to nothing — if the step changes while one is pending.
   * `WebAuthnAbortService` is a module singleton shared with the passkey
   * plugin, which is why `@simplewebauthn/browser` is pinned to the same
   * range the plugin asks for.
   */
  useEffect(() => {
    if (!isHostedBuild || step !== "email" || !config.passkeys) return;
    let live = true;

    void (async () => {
      const available = await conditionalMediationAvailable();
      if (!live || !available) return;
      const result = await signIn.passkey({ autoFill: true });
      if (!live || !result || result.error) return;
      finish();
    })();

    return () => {
      live = false;
      WebAuthnAbortService.cancelCeremony();
    };
  }, [step, config.passkeys, finish]);

  if (!isHostedBuild) return <HostedUnavailable />;

  function set<K extends keyof Fields>(key: K, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
    // Clear the field's error as soon as it is being fixed, but leave the
    // form-level error alone — that one is about the last submission.
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }

  function restart() {
    setStep("email");
    setLookup(null);
    setErrors({});
    setFormError(null);
    setNotice(null);
    setFields((prev) => ({ ...prev, name: "", password: "" }));
  }

  async function guard<T>(key: string, run: () => Promise<T>): Promise<void> {
    setBusy(key);
    setFormError(null);
    try {
      await run();
    } catch {
      setFormError(
        "Could not reach mtmux. Check your connection and try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function onEmailSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = fields.email.trim();
    if (!email) {
      setErrors({ email: "Enter your email address." });
      return;
    }
    if (!EMAIL.test(email)) {
      setErrors({ email: "That doesn't look like an email address." });
      return;
    }
    setErrors({});
    await resolveEmail(email);
  }

  async function onPasswordSignIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!fields.password) {
      setErrors({ password: "Enter your password." });
      return;
    }
    setErrors({});
    await guard("password", async () => {
      const result = await signIn.email({
        email: fields.email.trim(),
        password: fields.password,
        rememberMe: true,
      });
      if (result.error) {
        setFormError(
          result.error.message ?? "That password doesn't match this account.",
        );
        return;
      }
      finish();
    });
  }

  async function onSignUp(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found: FieldErrors = {};
    if (!fields.name.trim()) found.name = "Tell us what to call you.";
    if (!fields.password) found.password = "Choose a password.";
    else if (fields.password.length < MIN_PASSWORD) {
      found.password = `Use at least ${MIN_PASSWORD} characters.`;
    }
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;

    await guard("signup", async () => {
      const result = await signUp.email({
        name: fields.name.trim(),
        email: fields.email.trim(),
        password: fields.password,
        // Absolute, or better-auth resolves it against the API's origin.
        callbackURL: appUrl(next),
      });
      if (result.error) {
        setFormError(
          result.error.message ?? "Could not create the account. Try again.",
        );
        return;
      }
      // Before `finish()`, which may navigate straight back into the CLI's
      // device flow — someone who signs up mid-flow can go days before seeing
      // the dashboard, and the checklist should still be there when they do.
      markOnboardingStarted();
      finish();
    });
  }

  async function onPasskey() {
    await guard("passkey", async () => {
      const result = await signIn.passkey();
      if (!result || result.error) {
        setFormError(
          result?.error?.message ?? "That passkey didn't work. Try again.",
        );
        return;
      }
      finish();
    });
  }

  async function onMagicLink() {
    await guard("magic", async () => {
      const result = await signIn.magicLink({
        email: fields.email.trim(),
        callbackURL: appUrl(next),
      });
      if (result.error) {
        setFormError(
          result.error.message ?? "Could not send the link. Try again.",
        );
        return;
      }
      setStep("magic-sent");
    });
  }

  async function onForgotPassword() {
    await guard("reset", async () => {
      const result = await authClient.requestPasswordReset({
        email: fields.email.trim(),
        redirectTo: appUrl("/signin/reset"),
      });
      if (result.error) {
        setFormError(
          result.error.message ?? "Could not send the email. Try again.",
        );
        return;
      }
      setStep("reset-sent");
    });
  }

  async function onSocial(provider: string) {
    await guard(`social:${provider}`, async () => {
      await signIn.social({
        provider: provider as "google" | "github",
        callbackURL: appUrl(next),
        // Where better-auth sends someone whose address already belongs to an
        // unlinked local account. Landing on the sign-in form with the address
        // filled in and an explanation is the difference between "sign in and
        // then connect this in Settings" and a dead end.
        errorCallbackURL: appUrl(
          `/signin?email=${encodeURIComponent(fields.email.trim())}` +
            `&error=account_not_linked&next=${encodeURIComponent(next)}`,
        ),
      });
    });
  }

  // Hold the form back until the session check settles, so a signed-in visitor
  // never sees a sign-in form flash before the redirect.
  const checking = isPending || Boolean(session);
  const working = busy !== null;

  const socialButtons =
    config.providers.length > 0 ? (
      <div className="space-y-2">
        {config.providers.map((provider) => (
          <Button
            key={provider}
            type="button"
            variant="outline"
            className="h-11 w-full"
            disabled={working || checking}
            onClick={() => void onSocial(provider)}
          >
            {busy === `social:${provider}` ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : null}
            Continue with {providerLabel(provider)}
          </Button>
        ))}
      </div>
    ) : null;

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-10">
      <Card>
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            {step === "magic-sent" || step === "reset-sent" ? (
              <MailCheck className="h-6 w-6 text-primary" aria-hidden />
            ) : (
              <Terminal className="h-6 w-6 text-primary" aria-hidden />
            )}
          </div>
          <CardTitle className="text-xl">
            <h1>{headingFor(step, mode)}</h1>
          </CardTitle>
          <CardDescription>
            {descriptionFor(step, fields.email)}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {notice && (
            <div className="rounded-md border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
              {notice}
            </div>
          )}
          {formError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{formError}</span>
            </div>
          )}

          {step === "email" && (
            <>
              <form onSubmit={onEmailSubmit} noValidate className="space-y-4">
                <Field
                  id="email"
                  label="Email"
                  error={errors.email}
                  input={
                    <Input
                      id="email"
                      name="email"
                      type="email"
                      inputMode="email"
                      // `webauthn` is what makes the browser offer a stored
                      // passkey from this field's own autofill dropdown. It
                      // must sit alongside `email`, not replace it.
                      autoComplete="webauthn email"
                      autoCapitalize="none"
                      autoFocus
                      spellCheck={false}
                      className="h-11"
                      value={fields.email}
                      onChange={(e) => set("email", e.target.value)}
                      aria-invalid={Boolean(errors.email)}
                      aria-describedby={
                        errors.email ? "email-error" : undefined
                      }
                      disabled={working}
                    />
                  }
                />
                <Button
                  type="submit"
                  className="h-11 w-full"
                  disabled={working || checking}
                >
                  {busy === "lookup" ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      Checking…
                    </>
                  ) : (
                    "Continue"
                  )}
                </Button>
              </form>

              {socialButtons && (
                <>
                  <Divider />
                  {socialButtons}
                </>
              )}
            </>
          )}

          {step === "signin" && (
            <>
              {/* Only offered when this account actually has one — showing a
                  password box to a Google-only account is the dead end the
                  lookup exists to prevent. */}
              {lookup?.hasPassword !== false && (
                <form
                  onSubmit={onPasswordSignIn}
                  noValidate
                  className="space-y-4"
                >
                  <Field
                    id="password"
                    label="Password"
                    error={errors.password}
                    input={
                      <Input
                        id="password"
                        name="password"
                        type="password"
                        autoComplete="current-password"
                        autoFocus
                        className="h-11"
                        value={fields.password}
                        onChange={(e) => set("password", e.target.value)}
                        aria-invalid={Boolean(errors.password)}
                        aria-describedby={
                          errors.password ? "password-error" : undefined
                        }
                        disabled={working}
                      />
                    }
                  />
                  <Button
                    type="submit"
                    className="h-11 w-full"
                    disabled={working || checking}
                  >
                    {busy === "password" ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        Signing in…
                      </>
                    ) : (
                      "Sign in"
                    )}
                  </Button>
                </form>
              )}

              {(lookup?.hasPasskey ||
                config.magicLink ||
                config.providers.length > 0) && <Divider />}

              <div className="space-y-2">
                {lookup?.hasPasskey && (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 w-full"
                    disabled={working || checking}
                    onClick={() => void onPasskey()}
                  >
                    {busy === "passkey" ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    ) : (
                      <Fingerprint className="h-4 w-4" aria-hidden />
                    )}
                    Use a passkey
                  </Button>
                )}

                {config.magicLink && (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 w-full"
                    disabled={working || checking}
                    onClick={() => void onMagicLink()}
                  >
                    {busy === "magic" ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    ) : (
                      <Mail className="h-4 w-4" aria-hidden />
                    )}
                    Email me a sign-in link
                  </Button>
                )}

                {socialButtons}
              </div>

              <div className="flex items-center justify-between pt-1 text-sm">
                <BackLink onClick={restart} />
                {config.passwordReset && lookup?.hasPassword !== false ? (
                  <button
                    type="button"
                    onClick={() => void onForgotPassword()}
                    disabled={working}
                    className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    Forgot password?
                  </button>
                ) : (
                  /*
                   * A sentence, not a disabled button.
                   *
                   * With no mailer configured there is no reset to offer, and
                   * the corner was simply empty — so someone who had forgotten
                   * their password stared at a form with no way forward and no
                   * statement that there wasn't one. Saying so is the whole
                   * fix; a greyed-out "Forgot password?" would imply the
                   * feature exists and is merely unavailable right now.
                   */
                  lookup?.hasPassword !== false && (
                    <span className="text-right text-xs text-muted-foreground">
                      No password reset on this deployment.
                    </span>
                  )
                )}
              </div>
            </>
          )}

          {step === "signup" && (
            <>
              <form onSubmit={onSignUp} noValidate className="space-y-4">
                <Field
                  id="email"
                  label="Email"
                  input={
                    <Input
                      id="email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      className="h-11"
                      value={fields.email}
                      readOnly
                      // Read-only rather than disabled: a disabled field is
                      // skipped by screen readers and by autofill, and the
                      // address is the one thing on this form the person has
                      // already told us.
                      aria-readonly
                    />
                  }
                />
                <Field
                  id="name"
                  label="Name"
                  error={errors.name}
                  input={
                    <Input
                      id="name"
                      name="name"
                      autoComplete="name"
                      autoFocus
                      className="h-11"
                      value={fields.name}
                      onChange={(e) => set("name", e.target.value)}
                      aria-invalid={Boolean(errors.name)}
                      aria-describedby={errors.name ? "name-error" : undefined}
                      disabled={working}
                    />
                  }
                />
                <Field
                  id="password"
                  label="Password"
                  error={errors.password}
                  hint={
                    config.passwordReset
                      ? `At least ${MIN_PASSWORD} characters.`
                      : `At least ${MIN_PASSWORD} characters. This deployment cannot send email, so there is no reset — keep it somewhere you can find it.`
                  }
                  input={
                    <Input
                      id="password"
                      name="password"
                      type="password"
                      autoComplete="new-password"
                      className="h-11"
                      value={fields.password}
                      onChange={(e) => set("password", e.target.value)}
                      aria-invalid={Boolean(errors.password)}
                      aria-describedby={
                        errors.password ? "password-error" : "password-hint"
                      }
                      disabled={working}
                    />
                  }
                />
                <Button
                  type="submit"
                  className="h-11 w-full"
                  disabled={working || checking}
                >
                  {busy === "signup" ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      Creating account…
                    </>
                  ) : (
                    "Create account"
                  )}
                </Button>
              </form>

              {socialButtons && (
                <>
                  <Divider />
                  {socialButtons}
                </>
              )}

              <div className="pt-1 text-sm">
                <BackLink onClick={restart} />
              </div>
            </>
          )}

          {(step === "magic-sent" || step === "reset-sent") && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {step === "magic-sent"
                  ? "Open it on this device to sign in. It works once, and only for a few minutes."
                  : "Follow it to choose a new password. It's good for an hour."}
              </p>
              <p className="text-sm text-muted-foreground">
                Nothing yet? Check spam, then try again.
              </p>
              <BackLink onClick={restart} />
            </div>
          )}

          {step === "email" && (
            <p className="pt-1 text-center text-xs text-muted-foreground">
              {mode === "signup"
                ? "Already have an account? Enter the same address — we'll work it out."
                : "New here? Enter your address and we'll set you up."}
            </p>
          )}
        </CardContent>
      </Card>

      <p className="mt-4 text-center text-sm text-muted-foreground">
        <Link
          href="/start"
          className="underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Back to mtmux
        </Link>
      </p>
    </div>
  );
}

/**
 * Whether the browser can run a conditional ceremony.
 *
 * Guarded three ways because all three happen: no `PublicKeyCredential` at all
 * on an insecure origin (`mtmux start` prints a LAN URL, where WebAuthn does
 * not exist), no `isConditionalMediationAvailable` on older Safari, and a
 * rejection from the call itself.
 */
async function conditionalMediationAvailable(): Promise<boolean> {
  try {
    const api = (
      globalThis as {
        PublicKeyCredential?: {
          isConditionalMediationAvailable?: () => Promise<boolean>;
        };
      }
    ).PublicKeyCredential;
    if (!api?.isConditionalMediationAvailable) return false;
    return await api.isConditionalMediationAvailable();
  } catch {
    return false;
  }
}

function headingFor(step: Step, mode: Mode): string {
  switch (step) {
    case "email":
      return mode === "signup" ? "Create your account" : "Sign in";
    case "signin":
      return "Welcome back";
    case "signup":
      return "Create your account";
    case "magic-sent":
      return "Check your email";
    case "reset-sent":
      return "Check your email";
  }
}

function descriptionFor(step: Step, email: string): string {
  switch (step) {
    case "email":
      return "One account, every machine, from any browser.";
    case "signin":
      return email;
    case "signup":
      return "Two more things and you're in.";
    case "magic-sent":
      return `We sent a sign-in link to ${email}.`;
    case "reset-sent":
      return `We sent a reset link to ${email}.`;
  }
}

function Divider() {
  return (
    <div className="relative py-1">
      <div className="absolute inset-0 flex items-center" aria-hidden>
        <span className="w-full border-t border-border" />
      </div>
      <div className="relative flex justify-center">
        <span className="bg-card px-2 text-xs text-muted-foreground">or</span>
      </div>
    </div>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
      Use a different email
    </button>
  );
}

function Field({
  id,
  label,
  error,
  hint,
  input,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  input: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className={cn(error && "text-destructive")}>
        {label}
      </Label>
      {input}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
