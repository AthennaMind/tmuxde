// @ts-nocheck
import * as __fd_glob_33 from "../content/docs/web-app/terminal.mdx?collection=docs"
import * as __fd_glob_32 from "../content/docs/web-app/sessions.mdx?collection=docs"
import * as __fd_glob_31 from "../content/docs/web-app/mobile.mdx?collection=docs"
import * as __fd_glob_30 from "../content/docs/web-app/index.mdx?collection=docs"
import * as __fd_glob_29 from "../content/docs/web-app/files.mdx?collection=docs"
import * as __fd_glob_28 from "../content/docs/relay/protocol.mdx?collection=docs"
import * as __fd_glob_27 from "../content/docs/relay/index.mdx?collection=docs"
import * as __fd_glob_26 from "../content/docs/agents/session-persistence.mdx?collection=docs"
import * as __fd_glob_25 from "../content/docs/agents/notifications.mdx?collection=docs"
import * as __fd_glob_24 from "../content/docs/agents/multi-agent-layouts.mdx?collection=docs"
import * as __fd_glob_23 from "../content/docs/agents/long-running-jobs.mdx?collection=docs"
import * as __fd_glob_22 from "../content/docs/agents/index.mdx?collection=docs"
import * as __fd_glob_21 from "../content/docs/agents/codex-cli.mdx?collection=docs"
import * as __fd_glob_20 from "../content/docs/agents/claude-code.mdx?collection=docs"
import * as __fd_glob_19 from "../content/docs/agents/approvals.mdx?collection=docs"
import * as __fd_glob_18 from "../content/docs/troubleshooting.mdx?collection=docs"
import * as __fd_glob_17 from "../content/docs/sharing.mdx?collection=docs"
import * as __fd_glob_16 from "../content/docs/self-hosting.mdx?collection=docs"
import * as __fd_glob_15 from "../content/docs/security.mdx?collection=docs"
import * as __fd_glob_14 from "../content/docs/sealed-tunnel.mdx?collection=docs"
import * as __fd_glob_13 from "../content/docs/recording.mdx?collection=docs"
import * as __fd_glob_12 from "../content/docs/pairing.mdx?collection=docs"
import * as __fd_glob_11 from "../content/docs/index.mdx?collection=docs"
import * as __fd_glob_10 from "../content/docs/getting-started.mdx?collection=docs"
import * as __fd_glob_9 from "../content/docs/doctor.mdx?collection=docs"
import * as __fd_glob_8 from "../content/docs/deployment.mdx?collection=docs"
import * as __fd_glob_7 from "../content/docs/configuration.mdx?collection=docs"
import * as __fd_glob_6 from "../content/docs/cli.mdx?collection=docs"
import * as __fd_glob_5 from "../content/docs/architecture.mdx?collection=docs"
import * as __fd_glob_4 from "../content/docs/accounts.mdx?collection=docs"
import { default as __fd_glob_3 } from "../content/docs/web-app/meta.json?collection=docs"
import { default as __fd_glob_2 } from "../content/docs/relay/meta.json?collection=docs"
import { default as __fd_glob_1 } from "../content/docs/agents/meta.json?collection=docs"
import { default as __fd_glob_0 } from "../content/docs/meta.json?collection=docs"
import { server } from 'fumadocs-mdx/runtime/server';
import type * as Config from '../source.config';

const create = server<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
    docs: {
      /**
       * Last modified date of document file, obtained from version control.
       */
      lastModified?: Date;
    },
  }
}>();

export const docs = await create.docs("docs", "content/docs", {"meta.json": __fd_glob_0, "agents/meta.json": __fd_glob_1, "relay/meta.json": __fd_glob_2, "web-app/meta.json": __fd_glob_3, }, {"accounts.mdx": __fd_glob_4, "architecture.mdx": __fd_glob_5, "cli.mdx": __fd_glob_6, "configuration.mdx": __fd_glob_7, "deployment.mdx": __fd_glob_8, "doctor.mdx": __fd_glob_9, "getting-started.mdx": __fd_glob_10, "index.mdx": __fd_glob_11, "pairing.mdx": __fd_glob_12, "recording.mdx": __fd_glob_13, "sealed-tunnel.mdx": __fd_glob_14, "security.mdx": __fd_glob_15, "self-hosting.mdx": __fd_glob_16, "sharing.mdx": __fd_glob_17, "troubleshooting.mdx": __fd_glob_18, "agents/approvals.mdx": __fd_glob_19, "agents/claude-code.mdx": __fd_glob_20, "agents/codex-cli.mdx": __fd_glob_21, "agents/index.mdx": __fd_glob_22, "agents/long-running-jobs.mdx": __fd_glob_23, "agents/multi-agent-layouts.mdx": __fd_glob_24, "agents/notifications.mdx": __fd_glob_25, "agents/session-persistence.mdx": __fd_glob_26, "relay/index.mdx": __fd_glob_27, "relay/protocol.mdx": __fd_glob_28, "web-app/files.mdx": __fd_glob_29, "web-app/index.mdx": __fd_glob_30, "web-app/mobile.mdx": __fd_glob_31, "web-app/sessions.mdx": __fd_glob_32, "web-app/terminal.mdx": __fd_glob_33, });