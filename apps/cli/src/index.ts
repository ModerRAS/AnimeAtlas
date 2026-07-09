#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { normalizeAlias } from "@animeatlas/core";
import {
  applyRepositoryApprovedContributions,
  planRepositoryApprovedContributions,
  planRepositoryMediaImport
} from "@animeatlas/importer";
import { createBangumiArchiveProviderFromFile } from "@animeatlas/provider-bangumi";
import { NormalizedMediaCandidate, ProviderRef } from "@animeatlas/providers";

type PlanItem = {
  media_id: string;
  provider_ref: ProviderRef;
  title: string;
};

type CliOptions = {
  file?: string;
  format: "auto" | "json" | "jsonl";
  lastSync?: string;
  pretty: boolean;
};

type ApplyApprovedOptions = {
  pretty: boolean;
  write: boolean;
};

type MetadataRecord = {
  metadata: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

async function main(argv: string[]): Promise<void> {
  const [scope, command, ...rest] = argv;

  if (scope === "resolve" && command === "alias") {
    const options = parseResolveOptions(rest);
    if (!options.value) {
      throw new CliUsageError("Missing alias value.");
    }
    const normalized = normalizeAlias(options.value);
    const entries = readGeneratedIndex("generated/indexes/aliases/exact.json");
    const mediaId = entries[normalized] ?? null;
    writeResolveResult({
      pretty: options.pretty,
      query: { type: "alias", value: options.value, normalized },
      mediaId
    });
    return;
  }

  if (scope === "resolve" && command === "provider") {
    const options = parseResolveOptions(rest);
    const [provider, entity, id] = options.positionals;
    if (!provider || !entity || !id) {
      throw new CliUsageError("Provider resolution requires provider, entity, and id.");
    }
    const key = `anime:${provider}:${entity}:${id}`;
    const entries = readGeneratedIndex("generated/indexes/provider-ids/exact.json");
    const mediaId = entries[key] ?? null;
    writeResolveResult({
      pretty: options.pretty,
      query: { type: "provider", provider, entity, id, key },
      mediaId
    });
    return;
  }

  if (scope === "contributions" && command === "apply-approved") {
    const options = parseApplyApprovedOptions(rest);
    const result = applyRepositoryApprovedContributions({ write: options.write });
    const document = {
      schema: "approved-contribution-apply-result/v1",
      mode: options.write ? "write" : "dry-run",
      written: result.written,
      applied_mutations: result.appliedMutations,
      files: result.files,
      summary: {
        mutations: result.plan.mutations.length,
        noops: result.plan.noops.length,
        conflicts: result.plan.conflicts.length
      },
      mutations: result.plan.mutations,
      noops: result.plan.noops,
      conflicts: result.plan.conflicts
    };

    process.stdout.write(`${JSON.stringify(document, null, options.pretty ? 2 : 0)}\n`);
    if (result.plan.conflicts.length > 0) {
      process.exitCode = 2;
    }
    return;
  }

  if (scope === "contributions" && command === "plan-approved") {
    const options = parsePlanApprovedOptions(rest);
    const plan = planRepositoryApprovedContributions();
    const document = {
      schema: "approved-contribution-plan/v1",
      summary: {
        mutations: plan.mutations.length,
        noops: plan.noops.length,
        conflicts: plan.conflicts.length
      },
      mutations: plan.mutations,
      noops: plan.noops,
      conflicts: plan.conflicts
    };

    process.stdout.write(`${JSON.stringify(document, null, options.pretty ? 2 : 0)}\n`);
    if (plan.conflicts.length > 0) {
      process.exitCode = 2;
    }
    return;
  }

  if (scope === "bangumi" && command === "plan-archive") {
    const options = parsePlanArchiveOptions(rest);
    if (!options.file) {
      throw new CliUsageError("Missing archive file path.");
    }

    const file = resolve(options.file);
    const provider = createBangumiArchiveProviderFromFile(file, {
      format: options.format,
      lastSync: options.lastSync
    });
    if (!provider.bulkImport) {
      throw new Error("Bangumi provider does not expose bulk_import.");
    }

    const plan = await planRepositoryMediaImport({ candidates: provider.bulkImport() });
    const document = {
      schema: "bangumi-archive-import-plan/v1",
      source: {
        provider: "bangumi",
        mode: "archive",
        file,
        format: options.format,
        ...(options.lastSync ? { last_sync: options.lastSync } : {})
      },
      summary: {
        matches: plan.matches.length,
        creates: plan.creates.length,
        conflicts: plan.conflicts.length
      },
      matches: plan.matches.map((item) => planItem(item.mediaId, item.candidate)),
      creates: plan.creates.map((item) => planItem(item.mediaId, item.candidate)),
      conflicts: plan.conflicts
    };

    process.stdout.write(`${JSON.stringify(document, null, options.pretty ? 2 : 0)}\n`);
    if (plan.conflicts.length > 0) {
      process.exitCode = 2;
    }
    return;
  }

  throw new CliUsageError(`Unknown command: ${argv.join(" ") || "<empty>"}`);
}

function parseResolveOptions(args: string[]): { value?: string; positionals: string[]; pretty: boolean } {
  const positionals: string[] = [];
  let pretty = true;
  for (const arg of args) {
    if (arg === "--compact") {
      pretty = false;
    } else if (arg === "--help" || arg === "-h") {
      throw new CliUsageError(usage(), 0);
    } else {
      positionals.push(arg);
    }
  }
  return { value: positionals.join(" "), positionals, pretty };
}

function parseApplyApprovedOptions(args: string[]): ApplyApprovedOptions {
  const options: ApplyApprovedOptions = { pretty: true, write: false };
  for (const arg of args) {
    if (arg === "--compact") {
      options.pretty = false;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new CliUsageError(usage(), 0);
    } else {
      throw new CliUsageError(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function parsePlanApprovedOptions(args: string[]): Pick<CliOptions, "pretty"> {
  const options = { pretty: true };
  for (const arg of args) {
    if (arg === "--compact") {
      options.pretty = false;
    } else if (arg === "--help" || arg === "-h") {
      throw new CliUsageError(usage(), 0);
    } else {
      throw new CliUsageError(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function parsePlanArchiveOptions(args: string[]): CliOptions {
  const options: CliOptions = { format: "auto", pretty: true };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--format") {
      const value = args[index + 1];
      if (value !== "auto" && value !== "json" && value !== "jsonl") {
        throw new CliUsageError("--format must be one of: auto, json, jsonl");
      }
      options.format = value;
      index += 1;
    } else if (arg === "--last-sync") {
      const value = args[index + 1];
      if (!value) {
        throw new CliUsageError("--last-sync requires an ISO timestamp value.");
      }
      options.lastSync = value;
      index += 1;
    } else if (arg === "--compact") {
      options.pretty = false;
    } else if (arg === "--help" || arg === "-h") {
      throw new CliUsageError(usage(), 0);
    } else if (arg.startsWith("-")) {
      throw new CliUsageError(`Unknown option: ${arg}`);
    } else if (!options.file) {
      options.file = arg;
    } else {
      throw new CliUsageError(`Unexpected argument: ${arg}`);
    }
  }

  return options;
}

function readGeneratedIndex(path: string): Record<string, string> {
  const data = JSON.parse(readFileSync(join(findRepoRoot(process.cwd()), path), "utf8")) as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data) || !("entries" in data)) {
    throw new Error(`${path} is not a generated index.`);
  }
  return (data as { entries: Record<string, string> }).entries;
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

function writeResolveResult(input: { pretty: boolean; query: Record<string, unknown>; mediaId: string | null }): void {
  const metadata = input.mediaId ? readMetadataRecord(input.mediaId) : null;
  const document = {
    schema: "offline-resolve-result/v1",
    query: input.query,
    found: input.mediaId !== null,
    media_id: input.mediaId,
    metadata: metadata?.metadata ?? null,
    provenance: metadata?._meta ?? null
  };
  process.stdout.write(`${JSON.stringify(document, null, input.pretty ? 2 : 0)}\n`);
  if (!input.mediaId) {
    process.exitCode = 2;
  }
}

function readMetadataRecord(mediaId: string): MetadataRecord {
  return JSON.parse(readFileSync(join(findRepoRoot(process.cwd()), "db/metadata", `${mediaId}.json`), "utf8")) as MetadataRecord;
}

function planItem(mediaId: string, candidate: NormalizedMediaCandidate): PlanItem {
  return {
    media_id: mediaId,
    provider_ref: candidate.providerRef,
    title: candidate.metadata.title
  };
}

function usage(): string {
  return `Usage:\n  animeatlas resolve alias <title-or-alias> [--compact]\n  animeatlas resolve provider <provider> <entity> <id> [--compact]\n  animeatlas bangumi plan-archive <file> [--format auto|json|jsonl] [--last-sync ISO_TIMESTAMP] [--compact]\n  animeatlas contributions plan-approved [--compact]\n  animeatlas contributions apply-approved [--write] [--compact]\n\nResolve commands use generated/ indexes for identity lookup and db/ metadata records for normalized metadata output. Contribution apply defaults to dry-run. It writes db/ records only with --write and never updates generated/ artifacts automatically.`;
}

class CliUsageError extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
  }
}

const args = process.argv.slice(2);
while (args[0] === "--") {
  args.shift();
}

main(args).catch((error: unknown) => {
  if (error instanceof CliUsageError) {
    process.stderr.write(`${error.message}\n`);
    if (error.code !== 0) {
      process.stderr.write(`${usage()}\n`);
    }
    process.exit(error.code);
  }

  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
