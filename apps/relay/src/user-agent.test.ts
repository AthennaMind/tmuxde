import { describe, expect, it } from "vitest";

import { describeUserAgent } from "./user-agent.js";

const UA = {
  iosSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  firefox:
    "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
  iosFirefox:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15",
  curl: "curl/8.5.0",
};

describe("describeUserAgent", () => {
  it("names the browser and the platform", () => {
    expect(describeUserAgent(UA.iosSafari)).toBe("Safari on iPhone");
    expect(describeUserAgent(UA.androidChrome)).toBe("Chrome on Android");
    expect(describeUserAgent(UA.macChrome)).toBe("Chrome on Mac");
    expect(describeUserAgent(UA.firefox)).toBe("Firefox on Linux");
  });

  /*
   * The only thing that makes this work: every browser impersonates the ones
   * below it. Edge says Chrome and Safari; Chrome says Safari; Firefox on iOS
   * says Safari because iOS makes it use WebKit. Test the impersonations
   * rather than the happy path — the happy path cannot fail.
   */
  it("is not fooled by a browser claiming to be another", () => {
    expect(describeUserAgent(UA.edge)).toBe("Edge on Windows");
    expect(describeUserAgent(UA.androidChrome)).not.toContain("Safari");
    expect(describeUserAgent(UA.iosFirefox)).toBe("Firefox on iPhone");
  });

  it("says whichever half it is sure of", () => {
    expect(describeUserAgent("curl/8.5.0 (Linux)")).toBe("Linux");
    expect(describeUserAgent("Chrome/1.0")).toBe("Chrome");
  });

  /*
   * Null rather than a guess. The caller falls back to "A device", which is
   * vague; a confident wrong answer is worse than vague, because the whole
   * point of the panel is telling one connection from another.
   */
  it("admits when it does not know", () => {
    expect(describeUserAgent(UA.curl)).toBeNull();
    expect(describeUserAgent("")).toBeNull();
    expect(describeUserAgent(null)).toBeNull();
    expect(describeUserAgent(undefined)).toBeNull();
  });
});
