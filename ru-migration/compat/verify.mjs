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
import { createYdbListingsRepository } from '../app/backend/repositories/ydb-listings.mjs';

for (const [name, value] of Object.entries({
  Driver, query, MetadataCredentialsProvider, S3Client, HeadBucketCommand,
  GetObjectCommand, PutObjectCommand, CopyObjectCommand, createPresignedPost, sharp,
})) {
  assert.equal(typeof value, 'function', name + ' must be exported as a function');
}
// The migration adapters rely on client.unsafe and begin, not just the module exports.
// Construct a local client without calling driver.ready() or executing SQL.
const offlineDriver = new Driver('grpc://127.0.0.1:2136/local');
const offlineSql = query(offlineDriver);
assert.equal(typeof offlineSql, 'function', 'query(driver) must return a tagged template client');
assert.equal(typeof offlineSql.unsafe, 'function', 'FAM adapters require client.unsafe(trustedSql)');
assert.equal(typeof offlineSql.begin, 'function', 'FAM adapters require client.begin(transactionCallback)');
const offlineStatement = offlineSql`SELECT $testValue;`;
assert.equal(typeof offlineStatement.parameter, 'function', 'FAM adapters require .parameter()');
assert.equal(typeof offlineStatement.timeout, 'function', 'FAM adapters require .timeout()');

// Construct the actual listing query with the pinned SDK without connecting to YDB.
// The wrapper deliberately does not execute the resulting statement.
let constructed = false;
const sentinel = "not-sql'); DELETE FROM fam_listings; --";
const repository = createYdbListingsRepository((strings, ...values) => {
  assert.equal(strings.join('').includes(sentinel), false);
  assert.ok(values.includes(sentinel));
  const statement = offlineSql(strings, ...values);
  assert.equal(typeof statement.parameter, 'function');
  constructed = true;
  return Promise.resolve();
});
await repository.createListing({ user_id: 'synthetic-user', school_id: 'synthetic-school', title: sentinel,
  description: 'Synthetic text', category: 'Учёба', price_text: 'Бесплатно', is_event: false,
  event_date: null, event_time: null, event_type: null, max_seats: 0, status: 'pending' });
assert.equal(constructed, true);


assert.equal(sharp.versions.sharp, '0.35.5', 'Installed native Sharp must match the pinned dependency');
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
console.log('SDK_COMPAT_PASS: pinned Sharp/WebP, YDB query-client methods, and AWS exports verified.');
console.log('No cloud integration was attempted; deployment remains blocked.');
