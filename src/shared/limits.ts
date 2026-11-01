// Limits the server enforces and the screens describe. One place, so changing one changes both.

export const MIN_PASSWORD_LENGTH = 10;

export const MAX_LOGO_BYTES = 1024 * 1024;
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
