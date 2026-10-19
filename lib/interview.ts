export function safeMeetingUrl(value: string): string {
  if (!value || value.length > 2048 || /[\s\p{Cc}]/u.test(value))
    return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.href.length <= 2048
      ? url.href
      : "";
  } catch {
    return "";
  }
}
