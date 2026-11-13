import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { createPendingImageStore } from './pending-images.mjs';

export function createS3PendingImageStore(env = process.env, { send } = {}) {
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
  return createPendingImageStore({ sharp, bucket, putObject });
}
