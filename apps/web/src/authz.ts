import type { AuthSession, GuestPermission } from "@online-video/shared";

export function hasPermission(session: AuthSession | null, permission: GuestPermission): boolean {
  return !!session && (!session.guest || session.guest.permissions.includes(permission));
}
export function landingPage(session: AuthSession): string {
  if (!session.guest) return "/";
  for (const [permission, path] of [["library", "/"], ["upload", "/upload"], ["pages", "/pages"], ["tasks", "/tasks"], ["configuration", "/categories"]] as const) {
    if (hasPermission(session, permission)) return path;
  }
  return "/access";
}
