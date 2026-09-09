// @ts-nocheck
import { browser } from 'fumadocs-mdx/runtime/browser';
import type * as Config from '../source.config';

const create = browser<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
    docs: {
      /**
       * Last modified date of document file, obtained from version control.
       */
      lastModified?: Date;
    },
  }
}>();
const browserCollections = {
  docs: create.doc("docs", {"accounts.mdx": () => import("../content/docs/accounts.mdx?collection=docs"), "architecture.mdx": () => import("../content/docs/architecture.mdx?collection=docs"), "cli.mdx": () => import("../content/docs/cli.mdx?collection=docs"), "configuration.mdx": () => import("../content/docs/configuration.mdx?collection=docs"), "deployment.mdx": () => import("../content/docs/deployment.mdx?collection=docs"), "doctor.mdx": () => import("../content/docs/doctor.mdx?collection=docs"), "getting-started.mdx": () => import("../content/docs/getting-started.mdx?collection=docs"), "index.mdx": () => import("../content/docs/index.mdx?collection=docs"), "pairing.mdx": () => import("../content/docs/pairing.mdx?collection=docs"), "recording.mdx": () => import("../content/docs/recording.mdx?collection=docs"), "sealed-tunnel.mdx": () => import("../content/docs/sealed-tunnel.mdx?collection=docs"), "security.mdx": () => import("../content/docs/security.mdx?collection=docs"), "self-hosting.mdx": () => import("../content/docs/self-hosting.mdx?collection=docs"), "sharing.mdx": () => import("../content/docs/sharing.mdx?collection=docs"), "troubleshooting.mdx": () => import("../content/docs/troubleshooting.mdx?collection=docs"), "agents/approvals.mdx": () => import("../content/docs/agents/approvals.mdx?collection=docs"), "agents/claude-code.mdx": () => import("../content/docs/agents/claude-code.mdx?collection=docs"), "agents/codex-cli.mdx": () => import("../content/docs/agents/codex-cli.mdx?collection=docs"), "agents/index.mdx": () => import("../content/docs/agents/index.mdx?collection=docs"), "agents/long-running-jobs.mdx": () => import("../content/docs/agents/long-running-jobs.mdx?collection=docs"), "agents/multi-agent-layouts.mdx": () => import("../content/docs/agents/multi-agent-layouts.mdx?collection=docs"), "agents/notifications.mdx": () => import("../content/docs/agents/notifications.mdx?collection=docs"), "agents/session-persistence.mdx": () => import("../content/docs/agents/session-persistence.mdx?collection=docs"), "relay/index.mdx": () => import("../content/docs/relay/index.mdx?collection=docs"), "relay/protocol.mdx": () => import("../content/docs/relay/protocol.mdx?collection=docs"), "web-app/files.mdx": () => import("../content/docs/web-app/files.mdx?collection=docs"), "web-app/index.mdx": () => import("../content/docs/web-app/index.mdx?collection=docs"), "web-app/mobile.mdx": () => import("../content/docs/web-app/mobile.mdx?collection=docs"), "web-app/sessions.mdx": () => import("../content/docs/web-app/sessions.mdx?collection=docs"), "web-app/terminal.mdx": () => import("../content/docs/web-app/terminal.mdx?collection=docs"), }),
};
export default browserCollections;