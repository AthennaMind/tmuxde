import { describe, it, expect, vi, afterEach } from "vitest";
import { makeConnectionGate } from "./start.js";

type Req = Parameters<ReturnType<typeof makeConnectionGate>["admit"]>[0];

const socket = (over: Partial<Req> = {}): Req => ({
  tokenId: "token-1",
  deviceId: "device-1",
  label: "iPhone · Safari",
  transport: "tunnel",
  userAgent: null,
  ...over,
});

afterEach(() => vi.useRealTimers());

/**
 * One question per *connection*, which is the change this gate exists to make.
 *
 * Every release before it asked once per credential, at pairing time: after
 * that a browser came and went as it liked, from any network, through the
 * tunnel, in silence. A credential is a file on somebody else's computer, and
 * "it paired once" is a fact about the past.
 *
 * The hard part is not refusing — it is refusing without turning an approved
 * device into a doorbell. These tests are that balance written down.
 */
describe("the connection gate", () => {
  it("asks about a device it has not been told about", async () => {
    const ask = vi.fn(async () => true);
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => [],
      ask,
    });
    expect(await gate.admit(socket())).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("refuses when the answer is no, and says nothing more about it", async () => {
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => [],
      ask: async () => false,
    });
    expect(await gate.admit(socket())).toBe(false);
  });

  it("does not ask twice about one act of approval", async () => {
    // Pairing seeds this. Without it the browser is asked again the instant it
    // connects — the same question, thirty milliseconds later, which is how a
    // product teaches people to hit yes without reading.
    const ask = vi.fn(async () => true);
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => [],
      ask,
    });
    gate.approve("device-1");
    expect(await gate.admit(socket())).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("collapses a burst of sockets into one question", async () => {
    // A browser is not one socket: tabs, the candidate race and a reconnect
    // storm all arrive at once, and asking about each literally would be eight
    // prompts for one act of opening a laptop.
    let settle!: (value: boolean) => void;
    const ask = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => [],
      ask,
    });
    const answers = Promise.all([
      gate.admit(socket()),
      gate.admit(socket()),
      gate.admit(socket()),
    ]);
    settle(true);
    expect(await answers).toEqual([true, true, true]);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("keeps covering a device for as long as it stays connected", async () => {
    vi.useFakeTimers();
    const ask = vi.fn(async () => true);
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => ["device-1"],
      ask,
    });
    expect(await gate.admit(socket())).toBe(true);
    // An hour of tabs and reconnects on a device that never went away.
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(await gate.admit(socket())).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("asks again once the device has been gone long enough", async () => {
    vi.useFakeTimers();
    const ask = vi.fn(async () => true);
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => [],
      ask,
    });
    expect(await gate.admit(socket())).toBe(true);
    // A blip is covered…
    vi.advanceTimersByTime(60_000);
    expect(await gate.admit(socket())).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    // …closing the laptop and coming back later is not.
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(await gate.admit(socket())).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("holds a refusal, so a device that was told no cannot ring again", async () => {
    vi.useFakeTimers();
    const ask = vi.fn(async () => false);
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => [],
      ask,
    });
    expect(await gate.admit(socket())).toBe(false);
    expect(await gate.admit(socket())).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    // Briefly, though: a mistaken `n` must not lock the owner out for long.
    vi.advanceTimersByTime(20_000);
    expect(await gate.admit(socket())).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("admits without asking when the policy says to trust", async () => {
    const ask = vi.fn(async () => false);
    const gate = makeConnectionGate({
      asks: () => false,
      connected: () => [],
      ask,
    });
    expect(await gate.admit(socket())).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("reads the policy at the moment a device connects, not at boot", async () => {
    // `a` on the live panel flips it without a restart, and a gate holding the
    // value it booted with would be the one control on that panel that
    // quietly does nothing.
    let asks = false;
    const ask = vi.fn(async () => true);
    const gate = makeConnectionGate({
      asks: () => asks,
      connected: () => [],
      ask,
    });
    await gate.admit(socket());
    expect(ask).not.toHaveBeenCalled();
    asks = true;
    await gate.admit(socket({ deviceId: "device-2" }));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("tells them apart by device, not by socket", async () => {
    const ask = vi.fn(async () => true);
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => [],
      ask,
    });
    await gate.admit(socket({ deviceId: "device-1" }));
    await gate.admit(socket({ deviceId: "device-2" }));
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("still has a key for a socket with no device behind it", async () => {
    // The machine's own bearer token has no pairing record. It is still a
    // connection, and it is still asked about.
    const ask = vi.fn(async () => true);
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => [],
      ask,
    });
    await gate.admit(socket({ deviceId: null, tokenId: null }));
    await gate.admit(socket({ deviceId: null, tokenId: null }));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("asks under the name the owner gave it", async () => {
    const named: string[] = [];
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => [],
      nameFor: () => "Work phone",
      ask: async (_req, name) => {
        named.push(name);
        return true;
      },
    });
    await gate.admit(socket());
    expect(named).toEqual(["Work phone"]);
  });
});
