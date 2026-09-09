"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { authClient, fetchAuthConfig, isHostedBuild } from "@/lib/auth-client";
import {
  clearStored,
  LAST_SESSION_KEY,
  ONBOARDING_DISMISSED_KEY,
  ONBOARDING_STARTED_KEY,
  readStored,
  SECOND_CREDENTIAL_DISMISSED_KEY,
  writeStored,
} from "@/lib/storage-keys";
import type { ServersState } from "@/hooks/use-servers";

/**
 * The first-run checklist, derived entirely from state that already exists.
 *
 * ## Derived, never flagged
 *
 * There is no `?welcome=1` and no "has seen onboarding" column. Every step
 * below is answered by something the dashboard already knows — the machine
 * list, this browser's device keys, the session census, the passkey list — so
 * the checklist is correct for a returning user on a new phone and correct for
 * someone who did half of it in a terminal, neither of which a flag can manage.
 *
 * The one stored bit is dismissal, and dismissal only hides it.
 *
 * ## Why this is not a `/welcome` route
 *
 * Every signal it needs is fetched by `/dashboard` already. A separate route
 * would need its own `RequireSession`, its own exit, its own answer to "what if
 * you already have six machines", and a change to the post-auth `next=` — four
 * new failure modes bought for a full-bleed layout.
 */

export type OnboardingStepId = "credential" | "machine" | "pair" | "session";

export type OnboardingStep = {
  id: OnboardingStepId;
  title: string;
  body: string;
  done: boolean;
};

export type OnboardingState = {
  /** False whenever the checklist must not render at all. */
  visible: boolean;
  steps: OnboardingStep[];
  /** The first step that is not done, or null when they all are. */
  next: OnboardingStep | null;
  doneCount: number;
  /**
   * Show the "add a second way in" prompt on its own.
   *
   * Once the checklist is dismissed or complete, a missing second credential is
   * still worth saying — but as a one-line banner with its own dismissal, not
   * as a resurrected checklist. An account with one credential and no mailer is
   * one lost device away from being unreachable, and there is no support desk.
   */
  showCredentialBanner: boolean;
  dismiss: () => void;
  dismissCredentialBanner: () => void;
};

const HIDDEN: OnboardingState = {
  visible: false,
  steps: [],
  next: null,
  doneCount: 0,
  showCredentialBanner: false,
  dismiss: () => {},
  dismissCredentialBanner: () => {},
};

/**
 * The step list, as a pure function of four facts.
 *
 * Split out of the hook so the precedence and the `null` handling can be tested
 * headless — this app's vitest runs in `node` with no DOM, and the interesting
 * part was never the rendering anyway.
 *
 * `credentialDone: null` means "we could not read the passkey list", and it
 * **omits** the step rather than asserting the account has no second way in.
 * Telling someone their account is unprotected when it is not is worse than
 * saying nothing, and it invites them to enrol a passkey they already have.
 */
export function deriveOnboardingSteps({
  credentialDone,
  hasMachine,
  hasPairing,
  hasSession,
}: {
  credentialDone: boolean | null;
  hasMachine: boolean;
  hasPairing: boolean;
  hasSession: boolean;
}): OnboardingStep[] {
  const all: OnboardingStep[] = [
    {
      id: "machine",
      title: "Put a machine on your account",
      body: "Install mtmux where your tmux sessions live, then run mtmux login on it.",
      done: hasMachine,
    },
    {
      id: "pair",
      title: "Pair this browser with it",
      body:
        "Ask to join from the dashboard. The machine still decides — whoever " +
        "is there runs mtmux approve and reads back six digits.",
      done: hasPairing,
    },
    {
      id: "session",
      title: "Open a session",
      body: "Real panes, the prefix key, and the scrollback you left behind.",
      done: hasSession,
    },
  ];

  /*
   * Last, not first, and only when we actually know.
   *
   * Only the *next* incomplete step shows its control, so whatever sits at the
   * top of this list owns the flow. Putting the credential ask there stalled
   * everything behind it: someone with a machine already registered was shown
   * "add a passkey" and no way to reach the pairing step that was the reason
   * they opened the page. Protecting an account is worth doing after there is
   * something in it, not before.
   *
   * `null` means the passkey list could not be read, and omits the step rather
   * than asserting the account has no second way in.
   */
  if (credentialDone !== null) {
    all.push({
      id: "credential",
      title: "Add a second way in",
      body:
        "A passkey on this device, so a forgotten password is not the end of " +
        "the account. mtmux has no support desk that can undo a lockout.",
      done: credentialDone,
    });
  }

  return all;
}

/** Marks a fresh sign-up, so the detour through the CLI device flow survives. */
export function markOnboardingStarted(): void {
  writeStored(ONBOARDING_STARTED_KEY, "1");
}

export function useOnboarding({
  servers,
  sessionCount,
}: {
  servers: ServersState;
  /** Sessions the census found, across every paired machine. */
  sessionCount: number;
}): OnboardingState {
  const [dismissed, setDismissed] = useState(true);
  const [bannerDismissed, setBannerDismissed] = useState(true);
  /**
   * `null` while unknown, and unknown is not the same as none.
   *
   * A failed `listUserPasskeys()` **hides** the credential step rather than
   * asserting "you have no passkeys" — the same distinction `security-panel.tsx`
   * draws with its `loadFailed`, and for the same reason: telling someone their
   * account has no second credential when it does is a false statement about
   * what is guarding it.
   */
  const [passkeyCount, setPasskeyCount] = useState<number | null>(null);
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null);
  const [mailerOn, setMailerOn] = useState<boolean | null>(null);
  /** Whether this browser has ever opened a session, from localStorage. */
  const [openedSession, setOpenedSession] = useState(false);

  // localStorage is read in an effect, not during render: this component is
  // server-rendered first, and reading it inline is a hydration mismatch that
  // flashes the checklist at someone who dismissed it a week ago.
  useEffect(() => {
    setDismissed(readStored(ONBOARDING_DISMISSED_KEY) !== null);
    setBannerDismissed(readStored(SECOND_CREDENTIAL_DISMISSED_KEY) !== null);
    setOpenedSession(readStored(LAST_SESSION_KEY) !== null);
  }, []);

  useEffect(() => {
    if (!isHostedBuild) return;
    let live = true;

    void (async () => {
      const [keys, config, session] = await Promise.allSettled([
        authClient.passkey.listUserPasskeys(),
        fetchAuthConfig(),
        authClient.getSession(),
      ]);
      if (!live) return;

      // `Promise.allSettled` is not enough on its own: better-auth resolves a
      // failed request to `{ data: null, error }` rather than rejecting, so a
      // 500 arrived here as `fulfilled` and `data ?? []` turned it into "this
      // account has no passkeys" — the exact false statement the `null` state
      // exists to prevent. The array itself has to be the signal.
      if (keys.status === "fulfilled" && Array.isArray(keys.value.data)) {
        setPasskeyCount(keys.value.data.length);
      }
      if (config.status === "fulfilled") {
        // Verification mail can only be a second way in when a mailer exists.
        setMailerOn(config.value.passwordReset || config.value.magicLink);
      }
      if (session.status === "fulfilled") {
        setEmailVerified(session.value.data?.user?.emailVerified === true);
      }
    })();

    return () => {
      live = false;
    };
  }, []);

  const dismiss = useCallback(() => {
    writeStored(ONBOARDING_DISMISSED_KEY, String(Date.now()));
    // The sign-up marker has done its job; leaving it would be one more thing
    // that could resurrect a dismissed checklist later.
    clearStored(ONBOARDING_STARTED_KEY);
    setDismissed(true);
  }, []);

  const dismissCredentialBanner = useCallback(() => {
    writeStored(SECOND_CREDENTIAL_DISMISSED_KEY, String(Date.now()));
    setBannerDismissed(true);
  }, []);

  const hasMachine = servers.servers.length > 0;
  const hasPairing = servers.pairedKeys.size > 0;
  const hasSession = sessionCount > 0 || openedSession;

  /**
   * `null` while the passkey list is unknown, so the step can be skipped rather
   * than guessed. A verified address plus a live mailer is the other way in:
   * password reset lands somewhere you can read.
   */
  const credentialDone =
    passkeyCount === null
      ? null
      : passkeyCount > 0 || (mailerOn === true && emailVerified === true);

  const steps = useMemo(
    () =>
      deriveOnboardingSteps({
        credentialDone,
        hasMachine,
        hasPairing,
        hasSession,
      }),
    [credentialDone, hasMachine, hasPairing, hasSession],
  );

  const doneCount = steps.filter((s) => s.done).length;
  const complete = steps.length > 0 && doneCount === steps.length;

  // Self-hosted builds never see any of this: it is entirely about an account
  // on our broker, and a build with no broker must make no claim about one.
  if (!isHostedBuild) return HIDDEN;

  /**
   * Wait for the machine list before deciding anything.
   *
   * `phase === "loading"` means `servers` is `[]` because nothing has arrived,
   * not because there is nothing — and a checklist that flashes "you have no
   * machines" at someone with ten of them is precisely the bug
   * `dashboard-unpaired.spec.ts` exists to catch.
   */
  if (servers.phase === "loading") return HIDDEN;

  return {
    visible: !dismissed && !complete,
    steps,
    next: steps.find((s) => !s.done) ?? null,
    doneCount,
    // Only once the checklist is out of the way, so the same ask is never on
    // screen twice.
    showCredentialBanner:
      (dismissed || complete) && credentialDone === false && !bannerDismissed,
    dismiss,
    dismissCredentialBanner,
  };
}
