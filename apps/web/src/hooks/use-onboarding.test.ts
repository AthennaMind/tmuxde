import { describe, expect, it } from "vitest";
import { deriveOnboardingSteps } from "./use-onboarding";

/**
 * The first-run checklist's derivation.
 *
 * The interesting property is not which sentences it produces — it is that it
 * never lies about the account. Two ways it could: by claiming there is no
 * second credential when the fetch that would have said so failed, and by
 * claiming there are no machines while the machine list is still in flight.
 * The first is pinned here; the second is pinned by the hook's
 * `phase === "loading"` guard, which is what `dashboard-unpaired.spec.ts`
 * covers end to end.
 */

const ALL_FALSE = {
  credentialDone: false,
  hasMachine: false,
  hasPairing: false,
  hasSession: false,
};

function ids(steps: ReturnType<typeof deriveOnboardingSteps>) {
  return steps.map((s) => s.id);
}

describe("deriveOnboardingSteps", () => {
  it("orders a cold account install → pair → open, credential last", () => {
    // The order is load-bearing: only the first incomplete step shows its
    // control, so a credential ask at the top would stall someone behind it
    // who came here to pair a machine they had already registered.
    const steps = deriveOnboardingSteps(ALL_FALSE);
    expect(ids(steps)).toEqual(["machine", "pair", "session", "credential"]);
    expect(steps.every((s) => !s.done)).toBe(true);
  });

  it("omits the credential step when the passkey list could not be read", () => {
    // Not `done: false`. An unreadable list is not an empty one, and rendering
    // it as one tells someone their account has no second way in when it may.
    const steps = deriveOnboardingSteps({
      ...ALL_FALSE,
      credentialDone: null,
    });
    expect(ids(steps)).toEqual(["machine", "pair", "session"]);
  });

  it("ticks each step from its own fact, independently", () => {
    const steps = deriveOnboardingSteps({
      credentialDone: true,
      hasMachine: true,
      hasPairing: false,
      hasSession: false,
    });
    const done = Object.fromEntries(steps.map((s) => [s.id, s.done]));
    expect(done).toEqual({
      credential: true,
      machine: true,
      pair: false,
      session: false,
    });
  });

  it("does not require the earlier steps to tick a later one", () => {
    // A returning user on a new phone can have a paired machine and sessions
    // while their passkey list is empty. Gating later steps on earlier ones
    // would show them a checklist that disagrees with what they can see.
    const steps = deriveOnboardingSteps({
      credentialDone: false,
      hasMachine: true,
      hasPairing: true,
      hasSession: true,
    });
    expect(steps.filter((s) => s.done).map((s) => s.id)).toEqual([
      "machine",
      "pair",
      "session",
    ]);
  });

  it("completes when every fact is true", () => {
    const steps = deriveOnboardingSteps({
      credentialDone: true,
      hasMachine: true,
      hasPairing: true,
      hasSession: true,
    });
    expect(steps.every((s) => s.done)).toBe(true);
  });

  it("never promises the machine will let you in", () => {
    // The strongest account-only capability is *discovery*, not consent. The
    // machine still decides, and this sentence is the one place the product
    // explains that at the moment it matters.
    const pair = deriveOnboardingSteps(ALL_FALSE).find((s) => s.id === "pair");
    expect(pair?.body).toContain("mtmux approve");
    expect(pair?.body).toContain("machine still decides");
  });
});
