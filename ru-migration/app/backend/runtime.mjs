import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata';
import { createOidcBearerAuthenticator } from './auth/oidc-bearer.mjs';
import { createDatabaseActorResolver } from './auth/database-actor.mjs';
import { createYdbListingsRepository } from './repositories/ydb-listings.mjs';
import { createListingsApi } from './services/listings-api.mjs';

export async function createRuntime(env = process.env) {
  const databaseUrl = env.FAM_RU_DATABASE_URL;
  const issuer = env.FAM_RU_AUTH_ISSUER;
  const audience = env.FAM_RU_AUTH_AUDIENCE;
  const jwksUri = env.FAM_RU_AUTH_JWKS_URL;
  if (!databaseUrl || !issuer || !audience || !jwksUri) return null;
  const metadataEndpoint = env.FAM_RU_YDB_METADATA_URL;
  const credentialsProvider = new MetadataCredentialsProvider(metadataEndpoint ? { endpoint: metadataEndpoint, flavor: 'Google' } : {});
  const driver = new Driver(databaseUrl, { credentialsProvider });
  await driver.ready();
  const sql = query(driver);
  const authenticate = createOidcBearerAuthenticator({ issuer, audience, jwksUri });
  const resolveActor = createDatabaseActorResolver(sql);
  const repository = createYdbListingsRepository(sql);
  const listingsApi = createListingsApi({ authenticate, resolveActor, repository });
  return { listingsApi, close: () => driver.close() };
}
