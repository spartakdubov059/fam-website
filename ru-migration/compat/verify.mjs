/**
 * Real native/SDK import compatibility smoke test; no credentials or cloud calls.
 * Run from this directory after npm install. Does not validate the actual YDB
 * database, runtime IAM, cloud pricing, or security of a live deployment.
 */
import assert from 'node:assert/strict';
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata';
import {
  S3Client, HeadBucketCommand, GetObjectCommand, PutObjectCommand, CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import sharp from 'sharp';

for (const [name, value] of Object.entries({
  Driver, query, MetadataCredentialsProvider, S3Client, HeadBucketCommand,
  GetObjectCommand, PutObjectCommand, CopyObjectCommand, createPresignedPost, sharp,
})) {
  assert.equal(typeof value, 'function', name + ' must be exported as a function');
}
const testImage = await sharp({
  create: { width: 16, height: 9, channels: 3, background: '#0080ff' },
}).jpeg().withMetadata({ density: 300 }).toBuffer();
const output = await sharp(testImage).rotate().webp({ quality: 78 }).toBuffer();
const metadata = await sharp(output).metadata();
assert.equal(metadata.format, 'webp');
assert.equal(metadata.width, 16);
assert.equal(metadata.height, 9);
assert.equal(metadata.exif, undefined);
assert.equal(metadata.xmp, undefined);
assert.equal(metadata.iptc, undefined);
console.log('SDK_COMPAT_PASS: native Sharp/WebP and YDB/AWS exports import successfully.');
console.log('No cloud integration was attempted; deployment remains blocked.');
