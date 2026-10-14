import { describe, it, expect, beforeEach } from "vitest";
import {
  IDLE,
  attachedName,
  needsAttach,
  nextAttachId,
  reduceAttach,
  resetAttachIds,
  shouldWriteOutput,
  type AttachState,
} from "./attach-state";

beforeEach(() => {
  resetAttachIds();
});

/** Drive the reducer the way the attach effect does. */
function request(state: AttachState, name: string) {
  const attachId = nextAttachId();
  return {
    attachId,
    state: reduceAttach(state, { type: "requestAttach", name, attachId }),
  };
}

describe("nextAttachId", () => {
  it("is monotonic", () => {
    expect(nextAttachId()).toBe("a1");
    expect(nextAttachId()).toBe("a2");
  });
});

describe("output gating", () => {
  it("drops output until the ack lands", () => {
    const { state, attachId } = request(IDLE, "work");
    expect(shouldWriteOutput(state)).toBe(false);

    const attached = reduceAttach(state, {
      type: "serverAttached",
      name: "work",
      attachId,
    });
    expect(shouldWriteOutput(attached)).toBe(true);
  });
});

describe("requestAttach", () => {
  it("is a no-op only for a settled attach to the same session", () => {
    const { state, attachId } = request(IDLE, "work");
    const attached = reduceAttach(state, {
      type: "serverAttached",
      name: "work",
      attachId,
    });

    expect(needsAttach(attached, "work")).toBe(false);
    expect(
      reduceAttach(attached, {
        type: "requestAttach",
        name: "work",
        attachId: "ignored",
      }),
    ).toBe(attached);
  });

  it("supersedes an attach that is still in flight to another session", () => {
    // The A -> B -> A wedge: switching back before B's ack used to skip the
    // re-attach entirely, leaving the client detached with nothing pending.
    let s = request(IDLE, "A").state;
    s = reduceAttach(s, {
      type: "serverAttached",
      name: "A",
      attachId: "a1",
    });
    expect(shouldWriteOutput(s)).toBe(true);

    const b = request(s, "B");
    expect(needsAttach(b.state, "A")).toBe(true);

    const backToA = request(b.state, "A");
    expect(backToA.state).toEqual({
      phase: "attaching",
      name: "A",
      attachId: "a3",
    });

    // B's late ack must not win.
    const afterStaleAck = reduceAttach(backToA.state, {
      type: "serverAttached",
      name: "B",
      attachId: b.attachId,
    });
    expect(afterStaleAck).toBe(backToA.state);
    expect(shouldWriteOutput(afterStaleAck)).toBe(false);

    const afterRealAck = reduceAttach(afterStaleAck, {
      type: "serverAttached",
      name: "A",
      attachId: backToA.attachId,
    });
    expect(shouldWriteOutput(afterRealAck)).toBe(true);
    expect(attachedName(afterRealAck)).toBe("A");
  });
});

describe("serverAttached", () => {
  it("ignores an ack whose attachId does not match the in-flight attach", () => {
    const { state } = request(IDLE, "work");
    const next = reduceAttach(state, {
      type: "serverAttached",
      name: "work",
      attachId: "stale",
    });
    expect(next).toBe(state);
    expect(shouldWriteOutput(next)).toBe(false);
  });

  it("falls back to name matching for relays that predate attachId", () => {
    const { state } = request(IDLE, "work");
    const next = reduceAttach(state, {
      type: "serverAttached",
      name: "work",
    });
    expect(shouldWriteOutput(next)).toBe(true);
  });

  it("ignores an ack when nothing is in flight", () => {
    expect(reduceAttach(IDLE, { type: "serverAttached", name: "work" })).toBe(
      IDLE,
    );
  });
});

describe("connectionLost", () => {
  it("reverts to attaching so exactly one re-attach is issued", () => {
    let s = request(IDLE, "work").state;
    s = reduceAttach(s, {
      type: "serverAttached",
      name: "work",
      attachId: "a1",
    });

    const lost = reduceAttach(s, { type: "connectionLost" });
    expect(lost.phase).toBe("attaching");
    expect(shouldWriteOutput(lost)).toBe(false);
    // Still needs an attach, and the desired session survives the outage.
    expect(needsAttach(lost, "work")).toBe(true);
    expect(attachedName(lost)).toBe("work");

    // A second connectionLost (status churns reconnecting -> connecting) must
    // not queue a second attach.
    const lostAgain = reduceAttach(lost, { type: "connectionLost" });
    expect(needsAttach(lostAgain, "work")).toBe(true);

    const reattached = reduceAttach(request(lostAgain, "work").state, {
      type: "serverAttached",
      name: "work",
      attachId: "a2",
    });
    expect(shouldWriteOutput(reattached)).toBe(true);
  });

  it("leaves idle alone", () => {
    expect(reduceAttach(IDLE, { type: "connectionLost" })).toBe(IDLE);
  });
});

describe("detach", () => {
  it("returns to idle", () => {
    const { state } = request(IDLE, "work");
    const next = reduceAttach(state, { type: "detach" });
    expect(next).toEqual(IDLE);
    expect(attachedName(next)).toBeNull();
  });
});
