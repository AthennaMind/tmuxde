import {
  Atom,
  BookOpen,
  Braces,
  Container,
  Database,
  File,
  FileArchive,
  FileCode2,
  FileText,
  Film,
  Folder,
  GitBranch,
  Image,
  Link,
  Music,
  Package,
  Palette,
  Settings2,
  SquareTerminal,
  Table2,
  Type,
} from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import type { FileEntry } from "@repo/protocol";
import { repositoryFileKind } from "./repository-file-kind";

const icons = {
  react: Atom,
  code: FileCode2,
  shell: SquareTerminal,
  json: Braces,
  config: Settings2,
  document: FileText,
  image: Image,
  audio: Music,
  video: Film,
  archive: FileArchive,
  database: Database,
  table: Table2,
  font: Type,
  style: Palette,
  package: Package,
  container: Container,
  git: GitBranch,
  readme: BookOpen,
  file: File,
  directory: Folder,
  symlink: Link,
};

export function RepositoryFileIcon({
  path,
  type = "file",
  className,
}: {
  path: string;
  type?: FileEntry["type"];
  className?: string;
}) {
  const kind =
    type === "file"
      ? repositoryFileKind(path)
      : type === "other"
        ? "file"
        : type;
  const Icon = icons[kind];
  return (
    <Icon
      aria-hidden="true"
      data-file-kind={kind}
      className={cn(
        "h-4 w-4 shrink-0",
        kind === "file" || kind === "symlink"
          ? "text-muted-foreground"
          : kind === "code" || kind === "react" || kind === "shell"
            ? "text-term-keyword"
            : kind === "image" ||
                kind === "audio" ||
                kind === "video" ||
                kind === "style" ||
                kind === "font"
              ? "text-term-value"
              : "text-term-path",
        className,
      )}
    />
  );
}
