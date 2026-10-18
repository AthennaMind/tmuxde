const extensions = {
  react: "jsx tsx",
  code: "js mjs cjs ts mts cts py pyw go rs java c cpp cc cxx h hpp cs rb php lua r swift kt kts scala dart vue svelte graphql gql prisma ex exs erl hs clj zig asm wasm html htm xml xsl",
  shell: "sh bash zsh fish ps1 bat cmd",
  json: "json jsonc json5 ipynb",
  config: "yaml yml toml ini conf cfg env properties editorconfig",
  document: "md mdx markdown txt rst adoc pdf doc docx odt rtf tex",
  image: "png jpg jpeg gif svg webp avif heic heif bmp ico tif tiff",
  audio: "mp3 wav ogg flac aac m4a opus aiff",
  video: "mp4 mov webm mkv avi m4v mpeg mpg",
  archive: "zip gz tgz tar bz2 xz zst rar 7z br",
  database: "sql sqlite sqlite3 db db3",
  table: "csv tsv xls xlsx ods parquet",
  font: "woff woff2 ttf otf eot",
  style: "css scss sass less styl",
} as const;

export type RepositoryFileKind =
  | keyof typeof extensions
  | "package"
  | "container"
  | "git"
  | "readme"
  | "file";

const extensionKinds = new Map<string, RepositoryFileKind>(
  Object.entries(extensions).flatMap(([kind, values]) =>
    values.split(" ").map((extension) => [extension, kind as RepositoryFileKind]),
  ),
);
const packageFiles = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "cargo.toml",
  "cargo.lock",
  "go.mod",
  "go.sum",
  "pyproject.toml",
  "requirements.txt",
  "poetry.lock",
  "uv.lock",
  "pipfile",
  "pipfile.lock",
  "gemfile",
  "gemfile.lock",
  "composer.json",
  "composer.lock",
  "pom.xml",
  "build.gradle",
]);

export function repositoryFileKind(path: string): RepositoryFileKind {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (packageFiles.has(name)) return "package";
  if (
    /^(dockerfile|containerfile)(\.|$)/.test(name) ||
    /^(docker-)?compose([.-].*)?\.ya?ml$/.test(name)
  )
    return "container";
  if ([".gitignore", ".gitattributes", ".gitmodules", ".gitkeep"].includes(name)) return "git";
  if (/^readme(\.|$)/.test(name)) return "readme";
  if (/^\.env(\.|$)/.test(name) || /^\.(.*rc|.*rc\..*|editorconfig)$/.test(name)) return "config";
  if (["makefile", "justfile", "taskfile"].includes(name)) return "shell";
  if (["license", "licence", "changelog", "authors", "notice"].includes(name)) return "document";
  return extensionKinds.get(name.split(".").pop() ?? "") ?? "file";
}
