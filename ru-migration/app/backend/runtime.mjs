import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata';
import { createOidcBearerAuthenticator } from './auth/oidc-bearer.mjs';
import { createDatabaseActorResolver } from './auth/database-actor.mjs';
import { createYandexIdAuth } from './auth/yandex-id.mjs';
import { createYdbListingsRepository } from './repositories/ydb-listings.mjs';
import { createListingsApi } from './services/listings-api.mjs';
import { createMediaApi } from './services/media-api.mjs';
import { createS3PendingImageStore } from './media/s3-pending-store.mjs';

export async function createRuntime(env = process.env) {
  const databaseUrl = env.FAM_RU_DATABASE_URL;
  const issuer = env.FAM_RU_AUTH_ISSUER;
  const audience = env.FAM_RU_AUTH_AUDIENCE;
  const jwksUri = env.FAM_RU_AUTH_JWKS_URL;
  const yandexConfigured = Boolean(env.FAM_RU_YANDEX_CLIENT_ID && env.FAM_RU_YANDEX_REDIRECT_URI && env.FAM_RU_SESSION_SECRET);
  const oidcConfigured = Boolean(issuer && audience && jwksUri);
  if (!databaseUrl || (!yandexConfigured && !oidcConfigured)) return null;
  const yandexAuth = yandexConfigured ? createYandexIdAuth({
    clientId: env.FAM_RU_YANDEX_CLIENT_ID,
    redirectUri: env.FAM_RU_YANDEX_REDIRECT_URI,
    sessionSecret: env.FAM_RU_SESSION_SECRET,
  }) : null;
  const authenticate = yandexAuth?.authenticate || createOidcBearerAuthenticator({ issuer, audience, jwksUri });
  const mediaConfigured = Boolean(env.FAM_RU_S3_ENDPOINT && env.FAM_RU_S3_BUCKET
    && env.FAM_RU_S3_ACCESS_KEY_ID && env.FAM_RU_S3_SECRET_ACCESS_KEY);
  const pendingImages = mediaConfigured ? createS3PendingImageStore(env) : null;
  const metadataEndpoint = env.FAM_RU_YDB_METADATA_URL;
  const credentialsProvider = new MetadataCredentialsProvider(metadataEndpoint ? { endpoint: metadataEndpoint, flavor: 'Google' } : {});
  const driver = new Driver(databaseUrl, { credentialsProvider });
  await driver.ready();
  const sql = query(driver);
  const resolveActor = createDatabaseActorResolver(sql);
  const repository = createYdbListingsRepository(sql);
  const listingsApi = createListingsApi({ authenticate, resolveActor, repository });
  const mediaApi = createMediaApi({ authenticate, resolveActor, pendingImages, repository });
  return {
    listingsApi,
    mediaApi,
    authApi: yandexAuth?.handle || null,
    close: async () => { pendingImages?.close?.(); await driver.close(); },
  };
}
