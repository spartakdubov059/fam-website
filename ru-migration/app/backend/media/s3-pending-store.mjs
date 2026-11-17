import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { createPendingImageStore } from './pending-images.mjs';

export function createS3PendingImageStore(env = process.env, { send, get, remove, list } = {}) {
  const endpoint = env.FAM_RU_S3_ENDPOINT;
  const bucket = env.FAM_RU_S3_BUCKET;
  const accessKeyId = env.FAM_RU_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.FAM_RU_S3_SECRET_ACCESS_KEY;
  const region = env.FAM_RU_S3_REGION || 'ru-central1';
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error('Private image storage is not configured');
  const parsed = new URL(endpoint);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid S3 endpoint');
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) throw new Error('S3 endpoint must use HTTPS');
  const client = new S3Client({ endpoint: parsed.origin, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
  const putObject = send || ((input) => client.send(new PutObjectCommand(input)));
  const getObject = get || ((input) => client.send(new GetObjectCommand(input)));
  const deleteObject = remove || ((input) => client.send(new DeleteObjectCommand(input)));
  const listObjects = list || ((input) => client.send(new ListObjectsV2Command(input)));
  const store = createPendingImageStore({ sharp, bucket, putObject });
  return Object.freeze({
    ...store,
    async get(key) {
      const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
      if (typeof key !== 'string' || !new RegExp(`^pending/${uuid}/${uuid}\\.webp$`, 'i').test(key)) throw new TypeError('invalid private image key');
      const result = await getObject({ Bucket: bucket, Key: key });
      if (result.ContentType !== 'image/webp' || !Number.isSafeInteger(Number(result.ContentLength)) || Number(result.ContentLength) < 1 || Number(result.ContentLength) > 5 * 1024 * 1024) throw new Error('invalid private image object');
      const bytes = Buffer.from(await result.Body.transformToByteArray());
      if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error('invalid private image object');
      return bytes;
    },
    async delete(key) {
      const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
      if (typeof key !== 'string' || !new RegExp(`^pending/${uuid}/${uuid}\\.webp$`, 'i').test(key)) throw new TypeError('invalid private image key');
      await deleteObject({ Bucket: bucket, Key: key });
      return true;
    },
    async listUserObjects(userId) {
      const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
      if (typeof userId !== 'string' || !new RegExp(`^${uuid}$`, 'i').test(userId)) throw new TypeError('invalid image owner');
      const prefix = `pending/${userId}/`;
      const keyPattern = new RegExp(`^pending/${userId}/${uuid}\\.webp$`, 'i');
      const keys = [];
      let continuationToken;
      for (let page = 0; page < 100; page++) {
        const result = await listObjects({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken, MaxKeys: 1000 });
        for (const item of result.Contents || []) {
          if (typeof item.Key !== 'string' || !keyPattern.test(item.Key)) throw new Error('unexpected account image object');
          keys.push(item.Key);
          if (keys.length > 100_000) throw new Error('account image inventory exceeds safe deletion limit');
        }
        if (!result.IsTruncated) return keys;
        if (typeof result.NextContinuationToken !== 'string' || !result.NextContinuationToken) throw new Error('incomplete account image inventory');
        continuationToken = result.NextContinuationToken;
      }
      throw new Error('account image inventory exceeds safe pagination limit');
    },
    close: () => client.destroy(),
  });
}
