/**
 * Guards the post-login redirect target. Only same-site absolute paths are
 * allowed, so a crafted ?next= cannot bounce a signed-in user to another host.
 */
export function safeNext(value: string | undefined, fallback: string): string {
  if (!value) return fallback;

  // Must start with a single slash. Rejects "//evil.com" and "https://evil.com".
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;

  // Reject backslashes, which some browsers normalize to forward slashes.
  if (value.includes('\\')) return fallback;

  return value;
}
