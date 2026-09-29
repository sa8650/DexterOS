/**
 * DexterOS — D1 database adapter.
 *
 * The only way the app reaches its database is the D1 binding configured on the
 * Pages project (a binding named "DB" is picked up automatically). There is no
 * API-token path: DexterOS never asks for, stores or sends a Cloudflare
 * credential, and the operators' own accounts are the only authentication the
 * product knows about.
 *
 * The rest of the application only ever sees: all(), first(), run(), exec().
 * Every query is parameterised — no string interpolation of user input anywhere.
 */
import { HttpError } from './util.js';

const BINDING_CANDIDATES = ['DB', 'DATABASE', 'D1', 'DEXTEROS_DB'];

export function resolveD1Binding(env) {
  const explicit = env.DEXTEROS_DB_BINDING;
  if (explicit && env[explicit]?.prepare) return { name: explicit, binding: env[explicit] };
  for (const name of BINDING_CANDIDATES) {
    if (env[name]?.prepare) return { name, binding: env[name] };
  }
  return null;
}

export function resolveR2Binding(env) {
  const candidates = ['MEDIA', 'BUCKET', 'STORAGE', 'R2', 'DEXTEROS_MEDIA'];
  const explicit = env.DEXTEROS_MEDIA_BINDING;
  if (explicit && env[explicit]?.put) return { name: explicit, binding: env[explicit] };
  for (const name of candidates) {
    if (env[name]?.put) return { name, binding: env[name] };
  }
  return null;
}

function d1BindingAdapter(d1) {
  return {
    kind: 'd1-binding',
    async all(sql, params = []) {
      const result = await d1.prepare(sql).bind(...params).all();
      return result?.results ?? [];
    },
    async first(sql, params = []) {
      const row = await d1.prepare(sql).bind(...params).first();
      return row ?? null;
    },
    async run(sql, params = []) {
      const result = await d1.prepare(sql).bind(...params).run();
      const meta = result?.meta ?? {};
      return { changes: meta.changes ?? 0, lastRowId: meta.last_row_id ?? null, meta };
    },
    async exec(sql) {
      // D1's exec() splits its input on newlines, so a multi-line CREATE TABLE
      // would be truncated. Our schema runner sends one statement at a time:
      // collapse whitespace and run it as a prepared statement.
      const single = String(sql).replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();
      if (!single) return true;
      await d1.prepare(single).run();
      return true;
    },
    async batch(statements) {
      const prepared = statements.map(({ sql, params = [] }) => d1.prepare(sql).bind(...params));
      return d1.batch(prepared);
    },
  };
}

/**
 * Returns a database adapter for this request, or throws a clear, actionable
 * error explaining exactly what to configure in the Cloudflare dashboard.
 */
export function getDb(env) {
  const bound = resolveD1Binding(env);
  if (bound) return { db: d1BindingAdapter(bound.binding), binding: bound.name, mode: 'binding' };

  throw new HttpError(
    503,
    'DexterOS is not connected to a database yet. Open Cloudflare → Workers & Pages → your Pages project → '
      + 'Settings → Functions → D1 database bindings, add a binding whose variable name is "DB" and points at your '
      + 'database, then redeploy. No API token or account id is needed.',
    'DB_NOT_CONFIGURED'
  );
}

/** Small helper so routes can express upserts consistently on both adapters. */
export async function upsert(db, { sql, params }) {
  return db.run(sql, params);
}
