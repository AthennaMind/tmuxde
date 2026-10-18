import type { RepositorySyntaxToken } from "./repository-syntax-tokens";

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
