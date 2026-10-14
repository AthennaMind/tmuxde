/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Relay WebSocket URL. Empty or unset means same origin.
  readonly VITE_RELAY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
