"use client";

import {
  ConnectionStatus,
  type ConnectionStatusType,
} from "@repo/ui/components/connection-status";
import { cn } from "@repo/ui/lib/utils";
import type { ConnectionState } from "@repo/protocol";
import { getRelayClient } from "@/hooks/use-websocket";
import { useConnectionStore } from "@/stores/connection-store";
import { MachineSwitcher } from "@/components/machines/machine-switcher";

function indicatorStatus(status: ConnectionState): ConnectionStatusType {
  if (status === "connected") return "connected";
  if (status === "connecting" || status === "authenticating")
    return "connecting";
  if (status === "reconnecting") return "reconnecting";
  return "disconnected";
}

/**
 * Connection and machine, at the foot of the desktop session sidebar.
 *
 * Healthy, this is context, so it sits last. Degraded, `ConnectionBanner`
 * takes over above the terminal. Collapsed, only the dot remains.
 */
export function SidebarStatus({ collapsed }: { collapsed: boolean }) {
  // Field by field. `setLatency` writes on every pong.
  const status = useConnectionStore((s) => s.status);
  const latency = useConnectionStore((s) => s.latency);
  const reconnectCount = useConnectionStore((s) => s.reconnectCount);
  const hostname = useConnectionStore((s) => s.hostname);

  return (
    <div
      className={cn(
        "flex min-h-11 shrink-0 items-center gap-2 border-t",
        collapsed ? "justify-center" : "justify-between ps-3 pe-1",
      )}
    >
      <ConnectionStatus
        status={indicatorStatus(status)}
        latency={latency ?? undefined}
        hostname={hostname ?? undefined}
        reconnectCount={reconnectCount}
        showLabel={!collapsed}
        onReconnect={
          collapsed
            ? undefined
            : () => {
                const client = getRelayClient();
                if (client) {
                  client.disconnect();
                  client.connect();
                }
              }
        }
        className="min-w-0"
      />
      {/* Always mounted: the command palette opens its sheet. */}
      <MachineSwitcher className={collapsed ? "hidden" : undefined} />
    </div>
  );
}
