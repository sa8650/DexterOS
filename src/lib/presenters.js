/**
 * DexterOS — API response shaping.
 * Rows never leave the server with password hashes; each presenter defines the
 * exact public shape of an entity.
 */
import { isAdmin } from './auth.js';

export const presentUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  status: u.status,
  title: u.title || '',
  phone: u.phone || '',
  verified: !!u.verified,
  avatar: { type: u.avatar_type || 'letter', value: u.avatar_value || null },
  created_at: u.created_at,
  last_login_at: u.last_login_at,
});

export const presentTenant = (tenant, viewer = null) => ({
  name: tenant.name,
  slug: tenant.slug,
  plan: tenant.plan,
  status: tenant.status,
  join_code: isAdmin(viewer) ? tenant.join_code : undefined,
  allow_join: tenant.allow_join === undefined ? undefined : !!tenant.allow_join,
  max_users: tenant.max_users,
  created_at: tenant.created_at,
});

export const presentApp = (a, usage) => ({
  id: a.id,
  name: a.name,
  url: a.url,
  category: a.category,
  description: a.description || '',
  icon: { type: a.icon_type, value: a.icon_value, bg: a.icon_bg || null },
  embed_mode: a.embed_mode,
  sort_order: a.sort_order,
  is_enabled: !!a.is_enabled,
  is_visible: !!a.is_visible,
  is_system: !!a.is_system,
  is_pinned: !!a.is_pinned,
  open_count: a.open_count,
  usage: usage ? { count: usage.open_count, last_opened_at: usage.last_opened_at } : { count: 0, last_opened_at: null },
  created_at: a.created_at,
  updated_at: a.updated_at,
});

export const presentWallpaper = (w) => ({
  id: w.id,
  name: w.name,
  description: w.description || '',
  kind: w.kind,
  value: w.value,
  thumb: w.thumb || (w.kind === 'image' ? w.value : null),
  storage_key: w.storage_key || null,
  is_enabled: !!w.is_enabled,
  is_default: !!w.is_default,
  sort_order: w.sort_order,
  created_at: w.created_at,
  updated_at: w.updated_at,
});

export const presentSettings = (row) => ({
  wallpaper_id: row?.wallpaper_id ?? null,
  accent: row?.accent || '#2563eb',
  theme: row?.theme || 'dark',
  taskbar_align: row?.taskbar_align || 'center',
  icon_size: row?.icon_size || 'medium',
  show_labels: row?.show_labels === undefined ? true : !!row.show_labels,
  reduced_transparency: !!row?.reduced_transparency,
  updated_at: row?.updated_at || null,
});

export const defaultSettingsRow = (userId, now) => ({
  user_id: userId,
  wallpaper_id: null,
  accent: '#2563eb',
  theme: 'dark',
  taskbar_align: 'center',
  icon_size: 'medium',
  show_labels: 1,
  reduced_transparency: 0,
  updated_at: now,
});
