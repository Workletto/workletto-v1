// The vendor brand. It belongs in vendor contexts only: the demo, licensing and the quiet
// "who made this" notes. A customer's installed app shows the customer's own brand,
// never this. Change the name here only.
export const PRODUCT_NAME = "Workletto";

// The vendor's Help Center. The "?" next to a page's title opens that page's article there.
// Vendor docs are one of the places the vendor name belongs (the branding rule in CLAUDE.md).
// A build can point elsewhere with VITE_HELP_CENTER_URL (a local Help Center while the site isn't live).
export const HELP_CENTER_URL = "https://workletto.com/help";

// The vendor's donation page (WRK-168): the one-time card on admins' Time screen and the line on
// Manage → About link here. Admins only, as quiet vendor attribution; the app sends nothing to it.
export const DONATE_URL = "https://workletto.com/support";
// The card appears this many days after the organization was set up, once the team has tracked time.
export const DONATION_PROMPT_AFTER_DAYS = 14;

// What the app calls itself before an organization exists (the page title
// while loading, the setup screen). Deliberately not a brand.
export const NEUTRAL_APP_NAME = "Time tracking";

/**
 * The name a customer's app shows for itself: the app name the organization
 * chose, else the organization's name, else a neutral label. Never PRODUCT_NAME.
 */
export function displayAppName(org?: { appName?: string | null; name?: string | null } | null): string {
  return org?.appName?.trim() || org?.name?.trim() || NEUTRAL_APP_NAME;
}
