import { createHash, randomBytes } from "node:crypto";

// Invite and password-reset links carry a random token. Only its hash is stored,
// so a copy of the database can't be used to open a link.

/** A new random token for a link. */
export const newToken = () => randomBytes(32).toString("base64url");

/** What is stored in place of a token. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
