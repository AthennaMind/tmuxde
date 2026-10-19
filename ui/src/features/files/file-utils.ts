const monacoLanguageMap: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yaml: "yaml",
  yml: "yaml",
  json: "json",
  toml: "ini",
  md: "markdown",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  xml: "xml",
  sql: "sql",
  graphql: "graphql",
  dockerfile: "dockerfile",
  makefile: "makefile",
  lua: "lua",
  r: "r",
  swift: "swift",
  kt: "kotlin",
  scala: "scala",
  dart: "dart",
  vue: "html",
  svelte: "html",
  prisma: "graphql",
};

export function getMonacoLanguage(filePath: string): string {
  const name = filePath.split("/").pop()?.toLowerCase() ?? "";

  // Handle special filenames
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === "makefile" || name === "gnumakefile") return "makefile";

  const ext = name.split(".").pop() ?? "";
  return monacoLanguageMap[ext] ?? "plaintext";
}

export function getLanguageLabel(filePath: string): string {
  const lang = getMonacoLanguage(filePath);
  return lang === "plaintext" ? "text" : lang;
}

/**
 * Category by extension. Drives the icon and label of the download card
 * and marks what never opens as text.
 */
const BINARY_EXTENSIONS: Record<string, string> = {
  // Images
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  svg: "image",
  webp: "image",
  avif: "image",
  apng: "image",
  bmp: "image",
  ico: "image",
  tif: "image",
  tiff: "image",
  heic: "image",
  heif: "image",
  psd: "image",
  // Video
  mp4: "video",
  m4v: "video",
  webm: "video",
  mov: "video",
  ogv: "video",
  mkv: "video",
  avi: "video",
  mpg: "video",
  mpeg: "video",
  wmv: "video",
  // Audio
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  aac: "audio",
  m4a: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  weba: "audio",
  aiff: "audio",
  wma: "audio",
  // Archives
  zip: "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  bz2: "archive",
  xz: "archive",
  zst: "archive",
  "7z": "archive",
  rar: "archive",
  // Documents
  pdf: "document",
  doc: "document",
  docx: "document",
  xls: "document",
  xlsx: "document",
  ppt: "document",
  pptx: "document",
  odt: "document",
  ods: "document",
  odp: "document",
  epub: "document",
  // Fonts
  ttf: "font",
  otf: "font",
  woff: "font",
  woff2: "font",
  eot: "font",
  // Data
  sqlite: "database",
  sqlite3: "database",
  db: "database",
  parquet: "database",
  // Compiled
  exe: "binary",
  bin: "binary",
  dll: "binary",
  so: "binary",
  dylib: "binary",
  o: "binary",
  a: "binary",
  wasm: "binary",
  class: "binary",
  pyc: "binary",
  img: "binary",
  iso: "binary",
};

export type FileViewMode = "text" | "image" | "video" | "audio" | "pdf" | "font" | "binary";

/**
 * Formats the browser decodes by itself. Other entries of
 * `BINARY_EXTENSIONS` get the download card, and the rest opens as text.
 */
const PREVIEW_MODES: Record<string, Exclude<FileViewMode, "text" | "binary">> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  svg: "image",
  webp: "image",
  avif: "image",
  apng: "image",
  bmp: "image",
  ico: "image",
  mp4: "video",
  m4v: "video",
  webm: "video",
  mov: "video",
  ogv: "video",
  mkv: "video",
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  aac: "audio",
  m4a: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  weba: "audio",
  pdf: "pdf",
  ttf: "font",
  otf: "font",
  woff: "font",
  woff2: "font",
};

/**
 * The extension of the base name in lower case, without the dot. A dot
 * that starts the name does not count, as in the server MIME table, so
 * ".png" has none.
 */
function fileExtension(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function getFileViewMode(path: string): FileViewMode {
  const ext = fileExtension(path);
  return PREVIEW_MODES[ext] ?? (BINARY_EXTENSIONS[ext] ? "binary" : "text");
}

export function getFileCategory(path: string): string | null {
  return BINARY_EXTENSIONS[fileExtension(path)] ?? null;
}

const MIB = 1024 * 1024;

/**
 * Most bytes a preview fetches on its own. Images and fonts arrive as one
 * blob before they show, so a bigger one waits for a click. Video, audio
 * and PDF stream from the server and have no limit. Zero means none.
 */
export function previewLimit(mode: FileViewMode): number {
  return mode === "image" || mode === "font" ? 10 * MIB : 0;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
