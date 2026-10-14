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
  if (name === "dockerfile" || name.startsWith("dockerfile."))
    return "dockerfile";
  if (name === "makefile" || name === "gnumakefile") return "makefile";

  const ext = name.split(".").pop() ?? "";
  return monacoLanguageMap[ext] ?? "plaintext";
}

export function getLanguageLabel(filePath: string): string {
  const lang = getMonacoLanguage(filePath);
  return lang === "plaintext" ? "text" : lang;
}

export const BINARY_EXTENSIONS: Record<string, string> = {
  // Images
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  svg: "image",
  webp: "image",
  bmp: "image",
  ico: "image",
  tiff: "image",
  // Video
  mp4: "video",
  webm: "video",
  mov: "video",
  avi: "video",
  mkv: "video",
  // Audio
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  aac: "audio",
  m4a: "audio",
  ogg: "audio",
  // Archives
  zip: "archive",
  tar: "archive",
  gz: "archive",
  bz2: "archive",
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
  // Fonts
  ttf: "font",
  otf: "font",
  woff: "font",
  woff2: "font",
  // Compiled
  exe: "binary",
  bin: "binary",
  dll: "binary",
  so: "binary",
  dylib: "binary",
};

export type FileViewMode =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "binary";

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "bmp",
  "ico",
]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac"]);

export function getFileViewMode(path: string): FileViewMode {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (
    BINARY_EXTENSIONS[ext] &&
    !IMAGE_EXTS.has(ext) &&
    !VIDEO_EXTS.has(ext) &&
    !AUDIO_EXTS.has(ext) &&
    ext !== "pdf"
  )
    return "binary";
  return "text";
}

export function isBinaryFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase();
  if (!ext) return false;
  return ext in BINARY_EXTENSIONS;
}

export function getFileCategory(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  return BINARY_EXTENSIONS[ext] ?? null;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
