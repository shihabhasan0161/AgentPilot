import { AppError } from "../../shared/contracts";

// Exact public DNS hostnames only. No implicit subdomains or mutable CDN sets.
export function domains(value: string, required = true): string[] {
  const result = [
    ...new Set(
      value
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (required && !result.length) throw new AppError("allowlist_required", 503);
  if (result.length > 50) throw new AppError("too_many_domains", 503);
  for (const host of result) {
    if (
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
        host,
      ) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host)
    ) {
      throw new AppError("invalid_allowlist", 503);
    }
  }
  return result;
}
export function validateUrl(raw: string, allowed: string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("invalid_url");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    !allowed.includes(url.hostname.toLowerCase())
  )
    throw new AppError("destination_not_allowed", 403);
  return url;
}
export function policy(navigation: string, assets: string) {
  const navigate = domains(navigation);
  const dependencies = domains(assets, false);
  const requests = [...new Set([...navigate, ...dependencies])];
  if (requests.length > 50) throw new AppError("too_many_domains", 503);
  return { navigate, requests };
}
