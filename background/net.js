export function fetchOptions(extra = {}) {
  return {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
    ...extra,
  };
}
