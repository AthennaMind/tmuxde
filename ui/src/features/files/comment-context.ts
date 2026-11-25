import { createContext, useContext } from "react";
import type { IRange } from "monaco-editor";
export interface CommentImage {
  file: File;
  directory: string;
  id: string;
  path: string;
}
export interface AgentComment {
  id: string;
  paneId?: string;
  diff?: {
    source?: {
      scope: import("@/features/workspace/main-tabs-store").ChangeScope;
      root: string;
      relativePath: string;
    };
    scope: string;
    location: string;
    text: string;
    rows: string[];
  };
  path: string;
  range?: IRange;
  snippet: string;
  note: string;
  images: CommentImage[];
}

export const CommentContext = createContext<{
  comments: AgentComment[];
  open: (comment: AgentComment) => void;
} | null>(null);
export function useCommentComposer() {
  const value = useContext(CommentContext);
  if (!value) throw new Error("Comment composer is required");
  return value;
}
