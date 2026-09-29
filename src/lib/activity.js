/**
 * DexterOS — audit trail.
 * Every meaningful change (apps, wallpapers, members, sign-ins, configuration)
 * is recorded per workspace and surfaced in the admin console.
 */
import { nowIso } from './util.js';

export async function logActivity(db, { tenantId, userId = null, actor = null, action, detail = null }) {
  try {
    await db.run(
      'INSERT INTO activity_log (tenant_id, user_id, actor, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [tenantId, userId, actor, action, detail, nowIso()]
    );
  } catch (error) {
    // Never let auditing break a user-facing action.
    console.warn('[dexteros] activity log failed:', error?.message);
  }
}
