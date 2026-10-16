import { Bot, Braces, CirclePlay, GitBranch, Server, SquareTerminal } from "lucide-react";
import { processPresentation } from "@/lib/session-presentation";
import { cn } from "@/lib/utils";

const ICONS = {
  agent: Bot,
  code: Braces,
  server: Server,
  git: GitBranch,
  terminal: SquareTerminal,
  process: CirclePlay,
};

/** Agents keep the primary color in every state, so they are easy to spot. */
export function ProcessIcon({
  command,
  active,
  className,
}: {
  command?: string;
  active?: boolean;
  className?: string;
}) {
  const { kind } = processPresentation(command);
  const Icon = ICONS[kind];
  return (
    <Icon
      aria-hidden
      strokeWidth={1.5}
      className={cn(
        "h-4 w-4 shrink-0 text-muted-foreground",
        active && "text-foreground",
        kind === "agent" && "text-primary",
        className,
      )}
    />
  );
}
