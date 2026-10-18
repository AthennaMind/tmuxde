import { ClientMessage } from "./client-messages";
import { ServerMessage } from "./server-messages";

export function serialize(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export function deserializeClientMessage(raw: string): ClientMessage {
  const parsed = JSON.parse(raw) as unknown;
  return ClientMessage.parse(parsed);
}

export function deserializeServerMessage(raw: string): ServerMessage {
  const parsed = JSON.parse(raw) as unknown;
  return ServerMessage.parse(parsed);
}

export function tryDeserializeClientMessage(
  raw: string,
): { ok: true; message: ClientMessage } | { ok: false; error: string } {
  try {
    const message = deserializeClientMessage(raw);
    return { ok: true, message };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown parse error",
    };
  }
}

export function tryDeserializeServerMessage(
  raw: string,
): { ok: true; message: ServerMessage } | { ok: false; error: string } {
  try {
    const message = deserializeServerMessage(raw);
    return { ok: true, message };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown parse error",
    };
  }
}
