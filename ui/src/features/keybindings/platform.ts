/** Which column of a binding applies: `mac` on Apple devices, `key` elsewhere. */
export type Platform = "mac" | "other";

export function isMacLike(): boolean {
  if (typeof navigator === "undefined") return false;
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /mac|iphone|ipad|ipod/i.test(data?.platform ?? navigator.platform ?? "");
}

export function currentPlatform(): Platform {
  return isMacLike() ? "mac" : "other";
}
