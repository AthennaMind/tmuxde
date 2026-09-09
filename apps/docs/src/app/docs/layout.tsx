import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { source } from "@/lib/source";
import type { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      nav={{ title: "mtmux docs" }}
      links={[
        { text: "mtmux.com", url: "https://mtmux.com" },
        // The docs describe the dashboard, the machine list and pairing from
        // the browser, and had no link to any of it — the app was reachable
        // only by typing the hostname.
        { text: "Open the app", url: "https://app.mtmux.com" },
        { text: "GitHub", url: "https://github.com/mtmux/mtmux" },
        { text: "npm", url: "https://www.npmjs.com/package/mtmux" },
      ]}
    >
      {children}
    </DocsLayout>
  );
}
