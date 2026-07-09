import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { normalizeAlias, sha256, sortStrings, stableStringify } from "@animeatlas/core";

type AnyRecord = Record<string, unknown>;
type GeneratedFiles = Map<string, string>;

type CheckResult = {
  ok: boolean;
  mismatches: string[];
};

const ROOT = findRepoRoot(process.cwd());

export function buildGeneratedFiles(root = ROOT): GeneratedFiles {
  const mediaRecords = readJsonFiles(join(root, "db", "media"));
  const aliasRecords = readJsonFiles(join(root, "db", "aliases"));
  const metadataRecords = readJsonFiles(join(root, "db", "metadata"));

  const aliasEntries: Record<string, string> = {};
  const providerEntries: Record<string, string> = {};
  const searchEntries = new Map<string, Set<string>>();

  for (const { data } of mediaRecords) {
    if (!isRecord(data) || typeof data.id !== "string" || data.kind !== "anime" || !Array.isArray(data.provider_refs)) {
      continue;
    }

    for (const ref of data.provider_refs) {
      if (!isRecord(ref) || typeof ref.provider !== "string" || typeof ref.entity !== "string" || typeof ref.id !== "string") {
        continue;
      }
      providerEntries[`anime:${ref.provider}:${ref.entity}:${ref.id}`] = data.id;
    }
  }

  for (const { data } of aliasRecords) {
    if (!isRecord(data) || typeof data.media_id !== "string" || !Array.isArray(data.aliases)) {
      continue;
    }

    for (const alias of data.aliases) {
      if (!isRecord(alias) || typeof alias.value !== "string") {
        continue;
      }
      const normalized = normalizeAlias(alias.value);
      aliasEntries[normalized] = data.media_id;
      for (const token of searchTokens(normalized)) {
        const ids = searchEntries.get(token) ?? new Set<string>();
        ids.add(data.media_id);
        searchEntries.set(token, ids);
      }
    }
  }

  for (const { data } of metadataRecords) {
    if (!isRecord(data) || typeof data.media_id !== "string" || !isRecord(data.metadata)) {
      continue;
    }
    const title = data.metadata.title;
    if (typeof title === "string") {
      const normalized = normalizeAlias(title);
      for (const token of searchTokens(normalized)) {
        const ids = searchEntries.get(token) ?? new Set<string>();
        ids.add(data.media_id);
        searchEntries.set(token, ids);
      }
    }
  }

  const searchObject: Record<string, string[]> = {};
  for (const key of sortStrings(searchEntries.keys())) {
    searchObject[key] = sortStrings(searchEntries.get(key) ?? []);
  }

  const files: GeneratedFiles = new Map();
  put(files, "generated/indexes/aliases/exact.json", {
    schema: "generated-alias-index/v1",
    entries: aliasEntries
  });
  put(files, "generated/indexes/provider-ids/exact.json", {
    schema: "generated-provider-id-index/v1",
    entries: providerEntries
  });
  put(files, "generated/indexes/search/tokens.json", {
    schema: "generated-search-index/v1",
    entries: searchObject
  });
  put(files, "generated/stats/summary.json", {
    schema: "generated-stats/v1",
    counts: {
      media: mediaRecords.length,
      alias_records: aliasRecords.length,
      metadata_records: metadataRecords.length,
      aliases: Object.keys(aliasEntries).length,
      provider_refs: Object.keys(providerEntries).length,
      search_terms: Object.keys(searchObject).length
    }
  });

  put(files, "generated/manifests/build.json", {
    schema: "build-manifest/v1",
    generator: "@animeatlas/generator@0.0.0",
    inputs: hashInputs(root),
    outputs: sortStrings(files.keys()).concat(["generated/manifests/build.json"])
  });

  return files;
}

export function writeGeneratedFiles(root = ROOT): string[] {
  const files = buildGeneratedFiles(root);
  const written: string[] = [];
  for (const [relativePath, content] of files.entries()) {
    const file = join(root, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    written.push(relativePath);
  }
  return written;
}

export function checkGeneratedFiles(root = ROOT): CheckResult {
  const expected = buildGeneratedFiles(root);
  const mismatches: string[] = [];

  for (const [relativePath, content] of expected.entries()) {
    const file = join(root, relativePath);
    if (!existsSync(file)) {
      mismatches.push(`${relativePath} is missing`);
      continue;
    }
    const current = readFileSync(file, "utf8");
    if (current !== content) {
      mismatches.push(`${relativePath} is stale`);
    }
  }

  const expectedPaths = new Set(expected.keys());
  for (const existing of listJsonFiles(join(root, "generated")).map((file) => toRepoPath(root, file))) {
    if (!expectedPaths.has(existing)) {
      mismatches.push(`${existing} is not produced by the generator`);
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}

function put(files: GeneratedFiles, path: string, value: unknown): void {
  files.set(path, stableStringify(value));
}

function findRepoRoot(start: string): string {
  let current = start;
  while (!existsSync(join(current, "pnpm-workspace.yaml"))) {
    const parent = dirname(current);
    if (parent === current) {
      return start;
    }
    current = parent;
  }
  return current;
}

function readJsonFiles(dir: string): Array<{ file: string; data: unknown }> {
  return listJsonFiles(dir).map((file) => ({ file, data: JSON.parse(readFileSync(file, "utf8")) }));
}

function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return listJsonFiles(path);
      }
      return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
    })
    .sort();
}

function hashInputs(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const file of listJsonFiles(join(root, "db"))) {
    hashes[toRepoPath(root, file)] = sha256(readFileSync(file));
  }
  return hashes;
}

function searchTokens(normalizedAlias: string): string[] {
  const tokens = new Set<string>([normalizedAlias]);
  for (const token of normalizedAlias.split(/[^\p{Letter}\p{Number}]+/u)) {
    if (token.length > 0) {
      tokens.add(token);
    }
  }
  return sortStrings(tokens);
}

function toRepoPath(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

function isRecord(value: unknown): value is AnyRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
