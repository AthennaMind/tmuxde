/**
 * A machine as the broker's `GET /v1/servers` describes it.
 *
 * It lives in its own file rather than beside the component that happens to
 * render it. It used to be exported from `server-row.tsx`, so `useServers` — a
 * hook with no opinion about rows — imported a type from a presentational
 * component, and deleting that component would have taken the type with it.
 *
 * The normalizer that produces these is `normalizeServer` in
 * `hooks/use-servers.ts`; nothing else should construct one from a raw body.
 */
export type RegisteredServer = {
  id: string;
  name: string;
  slug: string;
  /** Ed25519 identity, hex. The browser derives its local key id from this. */
  publicKey: string;
  online: boolean;
  lastSeenAt: number | null;
  platform: string | null;
  cliVersion: string | null;
};
