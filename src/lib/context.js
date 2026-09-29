/**
 * DexterOS — per-request context.
 *
 * Resolves the database adapter (the D1 binding), makes sure the schema exists,
 * loads the configuration and reports storage availability.
 * The "schema is ready" probe is cached per isolate so normal requests cost one
 * cheap SELECT, while a brand-new database is initialised automatically.
 */
import { configureHashing } from './auth.js';
import { getDb } from './db.js';
import { ensureSchema, SCHEMA_VERSION } from './schema.js';
import { loadSettings } from './settings.js';
import { mediaAvailability } from './media.js';
import { HttpError } from './util.js';

let probe = { key: null, promise: null };

function keyFor(mode, binding) {
  return `${mode}:${binding || 'unbound'}`;
}

export async function getContext(env) {
  configureHashing(env);
  const { db, mode, binding } = getDb(env);
  const key = keyFor(mode, binding);

  if (probe.key !== key) probe = { key, promise: null };
  if (!probe.promise) {
    probe.promise = (async () => {
      try {
        const row = await db.first("SELECT value FROM app_settings WHERE key = 'schema_version'");
        if (row?.value === SCHEMA_VERSION) return { initialized: false };
      } catch {
        // Table missing (or database brand new) — fall through and create it.
      }
      return ensureSchema(db);
    })().catch((error) => {
      probe.promise = null; // allow a later request to retry
      throw error;
    });
  }

  let schemaInfo;
  try {
    schemaInfo = await probe.promise;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, `Database initialisation failed: ${error.message}`, 'SCHEMA_FAILED');
  }

  const settings = await loadSettings(db, env);
  return {
    db,
    dbMode: mode,
    dbBinding: binding,
    settings,
    media: mediaAvailability(env),
    schemaJustCreated: !!schemaInfo?.created,
    env,
  };
}
