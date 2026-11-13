import { randomUUID } from 'node:crypto';

const MIME_TO_FORMAT = new Map([
  ['image/jpeg', 'jpeg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

// Inject the pinned Sharp factory and an S3-compatible PutObject function.
// Bucket policy must remain private; object keys are always server generated.
export function createPendingImageStore({ sharp, putObject, bucket, maxBytes = 5 * 1024 * 1024, maxPixels = 20_000_000 }) {
  if (typeof sharp !== 'function' || typeof putObject !== 'function' || typeof bucket !== 'string' || !bucket) {
    throw new TypeError('image storage dependencies are required');
  }
  return {
    async put({ userId, bytes, contentType }) {
      if (typeof userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(userId)) throw new TypeError('invalid user id');
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > maxBytes) throw new TypeError('invalid image size');
      if (!MIME_TO_FORMAT.has(String(contentType).toLowerCase())) throw new TypeError('unsupported image type');
      const image = sharp(bytes, { limitInputPixels: maxPixels, failOn: 'error' });
      const metadata = await image.metadata();
      if (!MIME_TO_FORMAT.has(`image/${metadata.format === 'jpg' ? 'jpeg' : metadata.format}`)) throw new TypeError('image content does not match an allowed format');
      const webp = await image.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
      const key = `pending/${userId}/${randomUUID()}.webp`;
      await putObject({ Bucket: bucket, Key: key, Body: webp, ContentType: 'image/webp', ServerSideEncryption: 'AES256' });
      return { key, contentType: 'image/webp', bytes: webp.length };
    },
  };
}
