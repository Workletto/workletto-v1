// Who can do what. Shared by the server (which enforces it) and the interface
// (which hides what someone can't use).

export const ROLES = ["admin", "manager", "member"] as const;
export type RoleName = (typeof ROLES)[number];

export const ROLE_LABELS: Record<RoleName, string> = { admin: "Admin", manager: "Manager", member: "Member" };

export const isRole = (value: unknown): value is RoleName => ROLES.includes(value as RoleName);

/** Clients and projects. */
export const canManageWork = (role: string) => role === "admin" || role === "manager";
/** People and appearance. */
export const canManageOrganization = (role: string) => role === "admin";
