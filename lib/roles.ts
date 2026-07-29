// lib/roles.ts
// Shared role-check helpers, usable from both server (resolvers, SSR pages)
// and client components. SUPER_ADMIN has at least every ADMIN capability, so
// anywhere that used to check `role === "ADMIN"` should use isAdminOrAbove
// instead — a strict equality check would accidentally lock the Super Admin
// out of ordinary admin-gated features.
export function isAdminOrAbove(role?: string | null): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

// Strictly the Super Admin — grant/revoke and the admin-management page are
// gated on this, not isAdminOrAbove, since regular Admins must not be able
// to grant/revoke Admin status on others.
export function isSuperAdmin(role?: string | null): boolean {
  return role === "SUPER_ADMIN";
}
