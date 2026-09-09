/**
 * Author registry.
 *
 * Posts reference an author by key. Real, attributable bylines linked to a
 * profile are an E-E-A-T signal: Google and AI answer engines both weight
 * author-to-entity linkage when deciding whether a technical page is credible.
 */

export type Author = {
  key: string;
  name: string;
  /** One line, shown under the byline. */
  role: string;
  /** Two or three sentences, shown in the post footer. */
  bio: string;
  /** Monogram used when no avatar image exists. */
  initials: string;
  /**
   * Set only when this byline is the project itself rather than a person. It
   * makes the JSON-LD author the same entity as the publisher, which is true,
   * instead of a `Person` named "The mtmux team", which is not.
   */
  isOrganization?: boolean;
  /**
   * A URL that identifies *this author* — a personal profile, not the product's
   * repository.
   *
   * All three authors used to carry the same repo URL, which schema.org reads as
   * three `Person` nodes that are the same thing. That is a worse entity signal
   * than none at all: an engine that would otherwise treat two bylines as two
   * distinct experts is told, in machine-readable terms, that they are one. So
   * this is left unset until there is a real per-author URL to put in it, and
   * `blogPostingSchema` gives each author a stable `@id` on our own domain
   * instead — which is what actually makes a byline an entity.
   */
  url?: string;
  /** Rendered as a "GitHub →" link on the author card. Only set it when it is theirs. */
  github?: string;
};

const repo = "https://github.com/mtmux/mtmux";

export const authors = {
  team: {
    key: "team",
    name: "The mtmux team",
    role: "Building mtmux",
    bio: "We build mtmux, an MIT-licensed CLI that serves the tmux sessions you already run to any browser, over an end-to-end encrypted tunnel.",
    initials: "mt",
    isOrganization: true,
    github: repo,
  },
  "ivo-hart": {
    key: "ivo-hart",
    name: "Ivo Hart",
    role: "Systems engineer, mtmux",
    bio: "Ivo works on the mtmux CLI and the pty bridge that attaches it to tmux. Fifteen years of terminal multiplexers, most of them spent arguing about prefix keys.",
    initials: "ih",
  },
  "nadia-okonkwo": {
    key: "nadia-okonkwo",
    name: "Nadia Okonkwo",
    role: "Protocol & crypto, mtmux",
    bio: "Nadia works on the pairing handshake and the sealed transport — the CPace exchange and the AES-GCM framing that keep the relay unable to read a session.",
    initials: "no",
  },
} as const satisfies Record<string, Author>;

export type AuthorKey = keyof typeof authors;

export const defaultAuthor: AuthorKey = "team";

export function getAuthor(key: string): Author {
  return authors[key as AuthorKey] ?? authors[defaultAuthor];
}
