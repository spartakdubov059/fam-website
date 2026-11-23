import { randomUUID } from 'node:crypto';

const MIME_TO_FORMAT = new Map([
  ['image/jpeg', 'jpeg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

// Inject the pinned Sharp factory and an S3-compatible PutObject function.
// Bucket policy must remain private; object keys are always server generated.
export function createPendingImageStore({ sharp, putObject, bucket, maxBytes = 5 * 1024 * 1024,
  maxOutputBytes = MAX_OUTPUT_BYTES, maxPixels = 20_000_000 }) {
  if (typeof sharp !== 'function' || typeof putObject !== 'function' || typeof bucket !== 'string' || !bucket) {
    throw new TypeError('image storage dependencies are required');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxOutputBytes)
      || maxOutputBytes < 1 || !Number.isSafeInteger(maxPixels) || maxPixels < 1) {
    throw new TypeError('image processing limits must be positive safe integers');
  }
  return {
    async put({ userId, bytes, contentType, maxBytes: requestedMaxBytes }) {
      const byteLimit = requestedMaxBytes == null ? maxBytes : Math.min(maxBytes, requestedMaxBytes);
      if (!Number.isSafeInteger(byteLimit) || byteLimit < 1) throw new TypeError('invalid image size limit');
      const outputLimit = Math.min(byteLimit, maxOutputBytes);
      if (typeof userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(userId)) throw new TypeError('invalid user id');
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > byteLimit) throw new TypeError('invalid image size');
      if (!MIME_TO_FORMAT.has(String(contentType).toLowerCase())) throw new TypeError('unsupported image type');
      let webp;
      try {
        const metadata = await sharp(bytes, { limitInputPixels: maxPixels, failOn: 'error' }).metadata();
        const actualContentType = `image/${metadata.format === 'jpg' ? 'jpeg' : metadata.format}`;
        if (!MIME_TO_FORMAT.has(actualContentType) || actualContentType !== String(contentType).split(';', 1)[0].trim().toLowerCase()) {
          throw new Error('image content type does not match its format');
        }
        for (const { dimensions, quality } of [
          { dimensions: 1600, quality: 78 }, { dimensions: 1600, quality: 68 },
          { dimensions: 1400, quality: 58 }, { dimensions: 1200, quality: 48 }, { dimensions: 1000, quality: 42 },
        ]) {
          webp = await sharp(bytes, { limitInputPixels: maxPixels, failOn: 'error' })
            .rotate().resize({ width: dimensions, height: dimensions, fit: 'inside', withoutEnlargement: true })
            .webp({ quality }).toBuffer();
          if (Buffer.isBuffer(webp) && webp.length > 0 && webp.length <= outputLimit) break;
        }
      } catch {
        const error = new TypeError('invalid image content');
        error.code = 'invalid_image';
        throw error;
      }
      if (!Buffer.isBuffer(webp) || webp.length < 1) throw new TypeError('invalid converted image size');
      if (webp.length > outputLimit) {
        const error = new TypeError('converted image exceeds size limit');
        error.code = 'image_too_large';
        throw error;
      }
      const key = `pending/${userId}/${randomUUID()}.webp`;
      await putObject({ Bucket: bucket, Key: key, Body: webp, ContentType: 'image/webp', ServerSideEncryption: 'AES256' });
      return { key, contentType: 'image/webp', bytes: webp.length };
    },
  };
}
