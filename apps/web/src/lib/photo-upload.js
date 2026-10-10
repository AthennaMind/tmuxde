// @ts-check
const MAX_PHOTO_SIZE = 10 * 1024 * 1024;
const CHUNK_SIZE = 128 * 1024;
const PHOTO_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

/** @param {string} path */
export function photoPathText(path) {
  // A path must never inject a terminal command or escape sequence.
  // eslint-disable-next-line no-control-regex
  if (!path.startsWith("/") || /[\x00-\x1f\x7f]/.test(path)) {
    throw new Error("Invalid photo path");
  }
  const quoted = /^[a-zA-Z0-9_./-]+$/.test(path)
    ? path
    : `'${path.replaceAll("'", "'\\''")}'`;
  return ` ${quoted} `;
}

/** @param {File} file */
export async function preparePhoto(file) {
  if (!file.size) throw new Error("Photo is empty");
  if (file.size > MAX_PHOTO_SIZE)
    throw new Error("Choose a photo smaller than 10 MB");
  if (PHOTO_TYPES.has(file.type)) return file;
  if (!file.type.startsWith("image/") && !/\.(heic|heif)$/i.test(file.name)) {
    throw new Error("Choose a PNG, JPEG, WebP, or GIF photo");
  }
  // Safari can decode phone formats that terminal agents cannot read directly.
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(
      1,
      4096 / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion unavailable");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.92),
    );
    if (!blob) throw new Error("Image conversion failed");
    return new File([blob], "photo.jpg", { type: "image/jpeg" });
  } catch {
    throw new Error(
      "Cannot read this photo. Choose a JPEG, PNG, or screenshot instead.",
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * @typedef {Pick<import("./ws-client").RelayClient, "status" | "send" | "onMessage" | "onStatusChange">} UploadClient
 * @param {UploadClient} client
 * @param {File} file
 * @param {string} directory
 */
export async function uploadPhoto(client, file, directory) {
  if (!file.size) throw new Error("Photo is empty");
  if (file.size > MAX_PHOTO_SIZE)
    throw new Error("Choose a photo smaller than 10 MB");
  const extension = PHOTO_TYPES.get(file.type);
  if (!extension) throw new Error("Unsupported photo format");
  const path = `${directory.replace(/\/$/, "")}/photo-${crypto.randomUUID()}.${extension}`;
  photoPathText(path);
  let interrupted = false;
  const stopWatching = client.onStatusChange((status) => {
    if (status !== "connected") interrupted = true;
  });
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      if (interrupted || client.status !== "connected")
        throw new Error("Connection lost. Upload photo again.");
      const chunk = bytes.subarray(offset, offset + CHUNK_SIZE);
      let binary = "";
      for (const byte of chunk) binary += String.fromCharCode(byte);
      const final = offset + chunk.length >= bytes.length;
      await sendPhotoChunk(client, {
        type: "file:upload",
        path,
        content: btoa(binary),
        final,
        ack: true,
      });
      if (!final) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return path;
  } finally {
    stopWatching();
  }
}

/** @param {UploadClient} client @param {import("@repo/protocol").FileUploadMessage} message */
function sendPhotoChunk(client, message) {
  return new Promise((resolve, reject) => {
    /** @type {() => void} */
    let offMessage = () => {};
    /** @type {() => void} */
    let offStatus = () => {};
    /** @param {Error=} error */
    const finish = (error) => {
      clearTimeout(timer);
      offMessage();
      offStatus();
      if (error) reject(error);
      else resolve(undefined);
    };
    const timer = setTimeout(
      () => finish(new Error("Upload timed out. Try again.")),
      20000,
    );
    offMessage = client.onMessage((reply) => {
      if (
        reply.type === "file:op:result" &&
        reply.op === "upload" &&
        reply.path === message.path
      ) {
        if (!reply.success) finish(new Error(reply.error ?? "Upload failed"));
        else if (reply.final === message.final) finish();
      } else if (
        reply.type === "error" &&
        ["ACCESS_DENIED", "RATE_LIMITED"].includes(reply.code)
      ) {
        finish(new Error(reply.message));
      }
    });
    offStatus = client.onStatusChange((status) => {
      if (status !== "connected")
        finish(new Error("Connection lost. Upload photo again."));
    });
    try {
      client.send(message);
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Upload failed"));
    }
  });
}
