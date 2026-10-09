/**
 * Origin checks for state-changing API routes.
 *
 * `request.url` is only as trustworthy as the proxy in front of the app: on
 * Railway the request arrives with an internal address, so comparing the
 * browser `Origin` header against `new URL(request.url).origin` rejects every
 * legitimate request. The configured public `NEXTAUTH_URL` is the other
 * allowed origin.
 */

/** Origins a state-changing request may come from. */
export function allowedRequestOrigins(request: Request): string[] {
  const origins = [new URL(request.url).origin];

  const configured = process.env.NEXTAUTH_URL?.trim();
  if (configured) {
    try {
      const origin = new URL(configured).origin;
      if (!origins.includes(origin)) origins.push(origin);
    } catch {
      // A malformed NEXTAUTH_URL must not widen or break the check; the same
      // env var is validated at startup by validateCoreEnv().
    }
  }

  return origins;
}

/**
 * True when a request passes the origin check. Requests without an `Origin`
 * header (same-origin fetches, non-browser clients) are allowed, matching the
 * previous behavior.
 */
export function isAllowedRequestOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return allowedRequestOrigins(request).includes(origin);
}
