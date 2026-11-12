// Server-side policy for FAM photo batches. Not a public approval endpoint.
// Caller must verify the JWT, listing ownership and database-backed role.
export const PHOTO_POLICY_VERSION = "fam-school-photo-v1";
export const MAX_PHOTOS = 5;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_BATCH_BYTES = 15 * 1024 * 1024;
export const MAX_SIDE = 2400;
export const MAX_PIXELS = 4_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

export function pendingPhotoPath(signedUrl, userId, origin) {
  if (typeof signedUrl !== "string" || signedUrl.length > 1600 || !UUID.test(String(userId))) return null;
  try {
    const url = new URL(signedUrl);
    if (url.origin !== origin || url.protocol !== "https:" || !url.searchParams.get("token")) return null;
    const prefix = "/storage/v1/object/sign/listing-images-pending/" + userId + "/";
    if (!url.pathname.startsWith(prefix)) return null;
    const rest = decodeURIComponent(url.pathname.slice(prefix.length));
    if (rest.includes("/") || rest.includes("\\") || rest.includes("..") || rest.includes("%")) return null;
    const filename = "listing_" + userId + "_";
    if (!rest.startsWith(filename)) return null;
    const suffix = rest.slice(filename.length);
    if (!/^[a-zA-Z0-9_-]{8,80}\\.(?:jpe?g|png|webp)$/i.test(suffix)) return null;
    return userId + "/" + rest;
  } catch { return null; }
}

export function validateSignedPhotoBatch(urls, userId, origin) {
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > MAX_PHOTOS)
    return { ok: false, error: "photo_count_limit", paths: [] };
  const paths = urls.map(url => pendingPhotoPath(url, userId, origin));
  if (paths.some(path => !path)) return { ok: false, error: "invalid_pending_photo", paths: [] };
  if (new Set(paths).size !== paths.length) return { ok: false, error: "duplicate_pending_path", paths: [] };
  return { ok: true, paths, error: null };
}

function getU16(bytes, pos) { return bytes[pos] << 8 | bytes[pos + 1]; }
function getU24LE(bytes, pos) { return bytes[pos] | bytes[pos + 1] << 8 | bytes[pos + 2] << 16; }
function getU32BE(bytes, pos) { return (bytes[pos] * 0x1000000) + (bytes[pos + 1] << 16) + (bytes[pos + 2] << 8) + bytes[pos + 3]; }
function ascii(bytes, pos, length) {
  return Array.from(bytes.slice(pos, pos + length), byte => String.fromCharCode(byte)).join("");
}

export function sniffImage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 24) return null;
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG" && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10 && ascii(bytes, 12, 4) === "IHDR") {
    return { mime: "image/png", width: getU32BE(bytes, 16), height: getU32BE(bytes, 20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let off = 2;
    while (off + 9 < bytes.length) {
      if (bytes[off] !== 0xff) return null;
      while (bytes[off] === 0xff) off++;
      const marker = bytes[off++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker >= 0xd0 && marker <= 0xd7 || marker === 0x01) continue;
      if (off + 2 > bytes.length) return null;
      const len = getU16(bytes, off);
      if (len < 2 || off + len > bytes.length) return null;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (len < 7) return null;
        return { mime: "image/jpeg", width: getU16(bytes, off + 5), height: getU16(bytes, off + 3) };
      }
      off += len;
    }
    return null;
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const kind = ascii(bytes, 12, 4);
    if (kind === "VP8X" && bytes.length >= 30) return {
      mime: "image/webp", width: 1 + getU24LE(bytes, 24), height: 1 + getU24LE(bytes, 27)
    };
    if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) return {
      mime: "image/webp",
      width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]),
      height: 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | ((bytes[22] & 0xc0) >> 6))
    };
    if (kind === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return {
      mime: "image/webp", width: ((bytes[27] << 8) | bytes[26]) & 0x3fff, height: ((bytes[29] << 8) | bytes[28]) & 0x3fff
    };
  }
  return null;
}

export function validatePhotoBytes(bytes, mime) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 24 || bytes.length > MAX_FILE_BYTES)
    return { ok: false, error: "invalid_file_size" };
  const info = sniffImage(bytes);
  if (!info || info.mime !== mime) return { ok: false, error: "invalid_image_signature" };
  if (!Number.isInteger(info.width) || !Number.isInteger(info.height) || info.width < 64 || info.height < 64 ||
      info.width > MAX_SIDE || info.height > MAX_SIDE || info.width * info.height > MAX_PIXELS)
    return { ok: false, error: "invalid_dimensions" };
  return { ok: true, ...info };
}

export async function sha256Hex(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, b => b.toString(16).padStart(2, "0")).join("");
}

export async function inspectPhotoBatch(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_PHOTOS)
    return { ok: false, error: "photo_count_limit" };
  if (files.reduce((n, file) => n + (file?.bytes?.length || 0), 0) > MAX_BATCH_BYTES)
    return { ok: false, error: "total_batch_size_limit" };
  const results = [];
  const seen = new Set();
  for (const file of files) {
    const check = validatePhotoBytes(file?.bytes, file?.mime);
    if (!check.ok) return { ok: false, error: check.error };
    const sha256 = await sha256Hex(file.bytes);
    if (seen.has(sha256)) return { ok: false, error: "duplicate_file_content" };
    seen.add(sha256);
    results.push({ sha256, mime: file.mime, width: check.width, height: check.height, bytes: file.bytes });
  }
  return { ok: true, files: results };
}

// This decision runs only AFTER the server's verified, policy-versioned cache lookup.
// Never accept client-provided approval hashes or roles. No implicit paid fallback.
export function planBatchReview(contentHashes, verifiedApprovedHashes, freeReviewSlots) {
  if (!Array.isArray(contentHashes) || contentHashes.length < 1 || contentHashes.length > MAX_PHOTOS ||
      contentHashes.some(hash => !/^[a-f0-9]{64}$/.test(hash)) || new Set(contentHashes).size !== contentHashes.length)
    return { action: "reject", reason: "invalid_hashes", reviewHashes: [] };
  const cache = verifiedApprovedHashes instanceof Set ? verifiedApprovedHashes : new Set();
  const need = contentHashes.filter(hash => !cache.has(hash));
  if (!need.length) return { action: "cached_approved", reviewHashes: [] };
  if (!Number.isSafeInteger(freeReviewSlots) || freeReviewSlots <= 0)
    return { action: "pending_budget", reviewHashes: need };
  return { action: "review_collage_once", reviewHashes: need };
}
