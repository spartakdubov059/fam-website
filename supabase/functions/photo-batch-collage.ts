// Server-side assembly: the browser must never supply the review collage itself.
// ImageScript v3 is pinned; images are decoded only after signature/dimension checks.
import { Image } from "npm:imagescript@3.13.1";
import { inspectPhotoBatch, MAX_PHOTOS } from "./photo-batch-policy.js";

const TILE = 512;
const COLS = 3;
const ROWS = 2;
const INSET = 12;

export async function buildModerationCollage(files) {
  const checked = await inspectPhotoBatch(files);
  if (!checked.ok) return { ok: false, error: checked.error, photoHashes: [] };
  if (checked.files.length > MAX_PHOTOS) return { ok: false, error: "photo_count_limit", photoHashes: [] };

  // The original files, not browser-created previews, are the sole source.
  const collage = new Image(COLS * TILE, ROWS * TILE).fill(0x15151dff);
  const sanitized = [];
  for (let index = 0; index < checked.files.length; index++) {
    const file = checked.files[index];
    let decoded;
    try {
      decoded = await Image.decode(file.bytes);
    } catch {
      return { ok: false, error: "image_decode_failed", photoHashes: [] };
    }
    if (decoded.width !== file.width || decoded.height !== file.height) {
      return { ok: false, error: "dimension_mismatch", photoHashes: [] };
    }
    // Re-encoding removes EXIF, location metadata and embedded comments.
    const safeBytes = await decoded.encodeJPEG({ quality: 84, metadata: {}, gainMap: false });
    sanitized.push({ sha256: file.sha256, mime: "image/jpeg", bytes: safeBytes });
    decoded.contain(TILE - 2 * INSET, TILE - 2 * INSET);
    const column = index % COLS;
    const row = Math.floor(index / COLS);
    const x = column * TILE + Math.floor((TILE - decoded.width) / 2);
    const y = row * TILE + Math.floor((TILE - decoded.height) / 2);
    collage.composite(decoded, { x, y });
  }
  // One server-generated JPEG for the complete batch, never five model calls.
  const reviewBytes = await collage.encodeJPEG({ quality: 86, metadata: {}, gainMap: false });
  return {
    ok: true, reviewBytes, contentType: "image/jpeg",
    sanitized, photoHashes: checked.files.map(file => file.sha256),
    rows: ROWS, columns: COLS, imageCount: checked.files.length
  };
}
