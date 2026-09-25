const HEALTH_PATH = "/__echo_proxy_health";
const ORIGIN_CONFIG_KEY = "origin_base_url";

function allowedOrigin(value: unknown): URL | null {
  if (typeof value !== "string") return null;

  try {
    const origin = new URL(value);
    if (origin.protocol !== "https:") return null;
    if (origin.username || origin.password || origin.port) return null;
    if (!/^[a-z0-9-]+\.trycloudflare\.com$/i.test(origin.hostname)) return null;
    return new URL(origin.origin);
  } catch {
    return null;
  }
}

async function currentOrigin(env: Env): Promise<URL> {
  const stored = allowedOrigin(await env.ORIGIN_CONFIG.get(ORIGIN_CONFIG_KEY));
  if (stored) return stored;

  const fallback = allowedOrigin(env.ORIGIN_BASE_URL);
  if (!fallback) throw new Error("No valid ECHO demo origin is configured.");
  return fallback;
}

async function refreshOrigin(env: Env): Promise<boolean> {
  const response = await fetch(env.ORIGIN_DISCOVERY_URL, {
    headers: { "user-agent": "echo-demo-proxy-discovery/1.0" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Origin discovery returned HTTP ${response.status}.`);

  const body = await response.json() as { demoOrigin?: unknown };
  const discovered = allowedOrigin(body.demoOrigin);
  if (!discovered) throw new Error("Origin discovery returned an invalid URL.");

  const stored = allowedOrigin(await env.ORIGIN_CONFIG.get(ORIGIN_CONFIG_KEY));
  if (stored?.origin === discovered.origin) return false;

  await env.ORIGIN_CONFIG.put(ORIGIN_CONFIG_KEY, discovered.origin);
  console.info(JSON.stringify({ event: "origin_updated", hostname: discovered.hostname }));
  return true;
}

function proxyOrigin(request: Request): string {
  return new URL(request.url).origin;
}

function rewriteLocation(location: string, request: Request, upstreamOrigin: URL): string {
  const resolved = new URL(location, upstreamOrigin);
  if (resolved.origin !== upstreamOrigin.origin) return location;

  const publicOrigin = new URL(proxyOrigin(request));
  resolved.protocol = publicOrigin.protocol;
  resolved.host = publicOrigin.host;
  return resolved.toString();
}

function rewriteSetCookie(cookie: string): string {
  // A cookie scoped to the ephemeral trycloudflare.com origin would not be
  // returned to this stable workers.dev hostname. Removing Domain makes it a
  // host-only cookie while preserving Path, Secure, HttpOnly and SameSite.
  return cookie.replace(/;\s*Domain=[^;]+/gi, "");
}

function forwardedHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  const incoming = new URL(request.url);

  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.slice(0, -1));
  headers.set("x-forwarded-port", incoming.port || "443");
  headers.delete("host");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");
  return headers;
}

async function originHealth(env: Env): Promise<Response> {
  try {
    const upstreamOrigin = await currentOrigin(env);
    const target = new URL("/api/auth/me", upstreamOrigin);
    const upstream = await fetch(target, {
      method: "HEAD",
      redirect: "manual",
      headers: { "user-agent": "echo-demo-proxy-health/1.0" },
    });
    const ok = upstream.status >= 200 && upstream.status < 500;
    return Response.json(
      { ok, upstreamStatus: upstream.status, activeOrigin: upstreamOrigin.origin },
      {
        status: ok ? 200 : 502,
        headers: { "cache-control": "no-store" },
      },
    );
  } catch {
    return Response.json(
      { ok: false, upstreamStatus: null, activeOrigin: null },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incoming = new URL(request.url);
    if (incoming.pathname === HEALTH_PATH) return originHealth(env);

    try {
      const upstreamOrigin = await currentOrigin(env);
      const target = new URL(incoming.pathname + incoming.search, upstreamOrigin);
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
      const upstream = await fetch(target, {
        method: request.method,
        headers: forwardedHeaders(request),
        body,
        redirect: "manual",
      });

      if (upstream.status === 101) return upstream;

      const headers = new Headers(upstream.headers);
      const location = headers.get("location");
      if (location) headers.set("location", rewriteLocation(location, request, upstreamOrigin));

      const cookies = upstream.headers.getSetCookie();
      if (cookies.length > 0) {
        headers.delete("set-cookie");
        for (const cookie of cookies) headers.append("set-cookie", rewriteSetCookie(cookie));
      }

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "origin_fetch_failed",
        path: incoming.pathname,
        error: error instanceof Error ? error.name : "UnknownError",
      }));
      return Response.json(
        { ok: false, error: "The ECHO demo origin is temporarily unavailable." },
        { status: 502, headers: { "cache-control": "no-store" } },
      );
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      const changed = await refreshOrigin(env);
      console.info(JSON.stringify({ event: "origin_discovery_complete", changed }));
    } catch (error) {
      console.error(JSON.stringify({
        event: "origin_discovery_failed",
        error: error instanceof Error ? error.name : "UnknownError",
      }));
    }
  },
} satisfies ExportedHandler<Env>;
