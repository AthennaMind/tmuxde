/** Sample rate of every model this service runs and of all audio it accepts. */
export const SAMPLE_RATE = 16_000;

/**
 * Signed 16-bit little-endian mono PCM to floats in [-1, 1].
 *
 * Returns null for an odd byte count, which cannot be whole samples.
 */
export function pcm16ToFloat32(bytes: Uint8Array): Float32Array | null {
  if (bytes.byteLength % 2 !== 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.byteLength / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }
  return samples;
}
