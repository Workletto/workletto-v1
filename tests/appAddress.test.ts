import { describe, expect, it } from "vitest";
import { appAddress, setupCodeSettingsUrl } from "../src/server/env.ts";

describe("the app's own web address", () => {
  it("is the one set by hand, then the host's own, then localhost", () => {
    expect(appAddress({ BETTER_AUTH_URL: "https://time.studio.example", RENDER_EXTERNAL_URL: "https://x.onrender.com" }, 3000)).toBe("https://time.studio.example");
    // Render gives a full address.
    expect(appAddress({ RENDER_EXTERNAL_URL: "https://workspace-ab12.onrender.com" }, 3000)).toBe("https://workspace-ab12.onrender.com");
    // Railway gives only the domain; it always serves HTTPS.
    expect(appAddress({ RAILWAY_PUBLIC_DOMAIN: "studio-time.up.railway.app" }, 3000)).toBe("https://studio-time.up.railway.app");
    expect(appAddress({ BETTER_AUTH_URL: "", RENDER_EXTERNAL_URL: "", RAILWAY_PUBLIC_DOMAIN: "" }, 4100)).toBe("http://localhost:4100");
  });
});

describe("the address set by hand", () => {
  it("loses a trailing slash, so links don't get a double one", () => {
    expect(appAddress({ BETTER_AUTH_URL: "https://time.studio.example/" }, 3000)).toBe("https://time.studio.example");
  });
});

describe("where the setup code lives", () => {
  it("is the Render service's Environment page on Render, and nowhere else", () => {
    expect(setupCodeSettingsUrl({ RENDER_SERVICE_ID: "srv-abc123" })).toBe("https://dashboard.render.com/web/srv-abc123/env");
    expect(setupCodeSettingsUrl({})).toBeNull();
    expect(setupCodeSettingsUrl({ RENDER_SERVICE_ID: "srv-x/../../evil" })).toBeNull();
    expect(setupCodeSettingsUrl({ RENDER_SERVICE_ID: "https://example.com" })).toBeNull();
  });
});
