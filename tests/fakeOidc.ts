import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";

// A tiny OpenID Connect provider for single sign-on tests (WRK-136): discovery, keys, an
// authorization code with PKCE, and RS256-signed ID tokens, like Google Workspace or Okta would
// give. Tests choose who signs in, then trade the code the way a browser would.

export type FakeProfile = { sub: string; email: string; name?: string; email_verified?: boolean };

const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

function sign(payload: Record<string, unknown>, key: KeyObject, kid: string) {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const body = b64url(JSON.stringify(payload));
  const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(key);
  return `${head}.${body}.${b64url(signature)}`;
}

export async function startFakeOidc(clientId: string, clientSecret: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomBytes(4).toString("hex");
  const codes = new Map<string, { profile: FakeProfile; challenge: string; nonce: string | null }>();
  const tokens = new Map<string, FakeProfile>();
  let issuer = "";
  // Who signs in when a browser comes to /authorize (browser tests); null: nobody, refused.
  let browserProfile: FakeProfile | null = null;

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return send(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      });
    }
    if (url.pathname === "/authorize") {
      const redirect = url.searchParams.get("redirect_uri");
      if (!browserProfile || !redirect) return send(403, { error: "access_denied" });
      const code = randomBytes(12).toString("hex");
      codes.set(code, { profile: browserProfile, challenge: url.searchParams.get("code_challenge") ?? "", nonce: url.searchParams.get("nonce") });
      const back = new URL(redirect);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/jwks") return send(200, { keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] });
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const basic = req.headers.authorization?.startsWith("Basic ") ? Buffer.from(req.headers.authorization.slice(6), "base64").toString() : null;
      const [id, secret] = basic ? basic.split(":").map(decodeURIComponent) : [form.get("client_id"), form.get("client_secret")];
      if (id !== clientId || secret !== clientSecret) return send(401, { error: "invalid_client" });
      const grant = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (!grant || b64url(createHash("sha256").update(verifier).digest()) !== grant.challenge) return send(400, { error: "invalid_grant" });
      const now = Math.floor(Date.now() / 1000);
      const accessToken = randomBytes(16).toString("hex");
      tokens.set(accessToken, grant.profile);
      const idToken = sign({ iss: issuer, aud: clientId, iat: now, exp: now + 600, ...(grant.nonce ? { nonce: grant.nonce } : {}), email_verified: true, ...grant.profile }, privateKey, kid);
      return send(200, { access_token: accessToken, token_type: "Bearer", expires_in: 600, id_token: idToken, scope: "openid email profile" });
    }
    if (url.pathname === "/userinfo") {
      const profile = tokens.get(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
      return profile ? send(200, { email_verified: true, ...profile }) : send(401, { error: "invalid_token" });
    }
    send(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  return {
    issuer,
    /** The person signs in at the provider: the code the provider sends back for this authorization address. */
    approve(authorizationUrl: string, profile: FakeProfile) {
      const url = new URL(authorizationUrl);
      const code = randomBytes(12).toString("hex");
      codes.set(code, { profile, challenge: url.searchParams.get("code_challenge") ?? "", nonce: url.searchParams.get("nonce") });
      return { code, state: url.searchParams.get("state") ?? "" };
    },
    /** Who a browser signs in as at /authorize, from now on. */
    signInBrowserAs(profile: FakeProfile | null) {
      browserProfile = profile;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
