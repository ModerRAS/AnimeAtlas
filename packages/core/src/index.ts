import { createHash } from "node:crypto";

export const MEDIA_ID_PATTERN = /^media-\d{6}$/;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export function isMediaId(value: unknown): value is string {
  return typeof value === "string" && MEDIA_ID_PATTERN.test(value);
}

export function mediaIdNumber(value: string): number {
  if (!isMediaId(value)) {
    throw new Error(`Invalid media id: ${value}`);
  }
  return Number(value.slice("media-".length));
}

export function formatMediaId(value: number): string {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid media id number: ${value}`);
  }
  return `media-${String(value).padStart(6, "0")}`;
}

export function nextMediaId(existingIds: Iterable<string>): string {
  let max = 0;
  for (const id of existingIds) {
    max = Math.max(max, mediaIdNumber(id));
  }
  return formatMediaId(max + 1);
}

export function normalizeAlias(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function sortStrings(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b, "en"));
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJson((value as Record<string, unknown>)[key]);
  }
  return sorted;
}
