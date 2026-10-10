"use client";

import React, { useEffect, useState } from "react";
import type { RepositorySyntaxToken } from "./repository-syntax-tokens";

export function useRepositorySyntax(
  path: string,
  content: string,
  isDiff: boolean,
) {
  const [state, setState] = useState<{
    path: string;
    content: string;
    isDiff: boolean;
    tokens?: RepositorySyntaxToken[][];
  }>();
  useEffect(() => {
    let cancelled = false;
    // Let plain text paint before parsing. Navigating away cancels this work.
    const timer = window.setTimeout(() => {
      void import("./repository-syntax-tokens")
        .then(({ highlightRepositoryCode }) =>
          cancelled
            ? undefined
            : highlightRepositoryCode(path, content, isDiff),
        )
        .then((tokens) => {
          if (!cancelled) setState({ path, content, isDiff, tokens });
        })
        .catch(() => {
          // Keep readable plain text if loading or tokenization fails.
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [path, content, isDiff]);
  return state?.path === path &&
    state.content === content &&
    state.isDiff === isDiff
    ? state.tokens
    : undefined;
}

export function RepositorySyntaxLine({
  line,
  tokens,
}: {
  line: string;
  tokens?: RepositorySyntaxToken[];
}) {
  if (!tokens?.length) return line || " ";
  return tokens.map((token, index) => (
    <span
      key={index}
      data-syntax-token={token.color ? "" : undefined}
      style={token.color ? { color: token.color } : undefined}
    >
      {token.content}
    </span>
  ));
}
