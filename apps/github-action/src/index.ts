#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isMediaId, stableStringify } from "@animeatlas/core";

type IssueEvent = {
  action?: string;
  label?: { name?: string };
  issue?: {
    number?: number;
    html_url?: string;
    body?: string | null;
    user?: { login?: string };
    updated_at?: string;
  };
  sender?: { login?: string };
};

type OperationType = "add_alias" | "add_provider_ref" | "correct_metadata";

type ContributionRecord = {
  schema: "contribution/v1";
  issue: {
    number: number;
    url: string;
    author: string;
  };
  operation: Record<string, unknown> & { type: OperationType };
  review: {
    approved_by: string;
    approved_at: string;
  };
};

type ParseResult =
  | { ok: true; contribution: ContributionRecord }
  | { ok: false; errors: string[] };

type WriteApprovedContributionOptions = {
  outDir?: string;
  force?: boolean;
  root?: string;
};

type WriteApprovedContributionResult = {
  file: string;
  written: boolean;
  contribution: ContributionRecord;
};

const NO_RESPONSE = "_No response_";
const OPERATION_TYPES = new Set<OperationType>(["add_alias", "add_provider_ref", "correct_metadata"]);
const ALIAS_TYPES = new Set(["official", "localized", "romaji", "nickname", "alternative", "legacy"]);
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const PROVIDER_KEY = /^[a-z][a-z0-9-]*$/;

export function parseIssueFormBody(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = body.split(/\r?\n/);
  let currentKey: string | undefined;
  let buffer: string[] = [];

  function flush(): void {
    if (!currentKey) {
      return;
    }
    const value = normalizeValue(buffer.join("\n"));
    if (value !== undefined) {
      result[currentKey] = value;
    }
  }

  for (const line of lines) {
    const heading = line.match(/^###\s+(.+)\s*$/);
    if (heading) {
      flush();
      currentKey = normalizeHeading(heading[1]);
      buffer = [];
      continue;
    }
    if (currentKey) {
      buffer.push(line);
    }
  }
  flush();

  return result;
}

export function contributionFromIssueEvent(event: IssueEvent): ParseResult {
  const errors: string[] = [];
  const issue = event.issue;
  if (!issue) {
    return { ok: false, errors: ["Event does not contain an issue payload."] };
  }

  if (event.action === "labeled" && event.label?.name !== "approved") {
    return { ok: false, errors: [`Ignoring label ${event.label?.name ?? "<unknown>"}; expected approved.`] };
  }

  const body = issue.body ?? "";
  const fields = parseIssueFormBody(body);
  const operation = operationFromFields(fields, errors);

  if (typeof issue.number !== "number") {
    errors.push("Issue number is required.");
  }
  if (!issue.html_url) {
    errors.push("Issue URL is required.");
  }
  if (!issue.user?.login) {
    errors.push("Issue author is required.");
  }
  if (!event.sender?.login) {
    errors.push("Approver login is required from event sender.");
  }
  if (!issue.updated_at) {
    errors.push("Issue updated_at is required for approved_at.");
  }

  if (!operation || errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    contribution: {
      schema: "contribution/v1",
      issue: {
        number: issue.number as number,
        url: issue.html_url as string,
        author: issue.user?.login as string
      },
      operation,
      review: {
        approved_by: event.sender?.login as string,
        approved_at: issue.updated_at as string
      }
    }
  };
}

export function writeApprovedContributionRecord(
  contribution: ContributionRecord,
  options: WriteApprovedContributionOptions = {}
): WriteApprovedContributionResult {
  const root = options.root ?? findRepoRoot(process.cwd());
  const outDir = resolveFromRoot(root, options.outDir ?? "source/contributions/approved");
  const content = stableStringify(contribution);
  const file = join(outDir, approvedContributionFileName(contribution));

  mkdirSync(outDir, { recursive: true });
  if (existsSync(file)) {
    const current = readFileSync(file, "utf8");
    if (current === content) {
      return { file, written: false, contribution };
    }
    if (!options.force) {
      throw new Error(`${file} already exists with different content. Use --force to overwrite.`);
    }
  }

  writeFileSync(file, content);
  return { file, written: true, contribution };
}

export function approvedContributionFileName(contribution: ContributionRecord): string {
  return `issue-${String(contribution.issue.number).padStart(6, "0")}.json`;
}

function operationFromFields(fields: Record<string, string>, errors: string[]): ContributionRecord["operation"] | undefined {
  const type = fields.change_type;
  if (!isOperationType(type)) {
    errors.push("Change Type must be one of add_alias, add_provider_ref, correct_metadata.");
    return undefined;
  }

  const mediaId = fields.media_id;
  if (!mediaId || !isMediaId(mediaId)) {
    errors.push("Media ID must be an existing-looking media-* ID such as media-000001.");
  }

  if (type === "add_alias") {
    const aliasType = fields.alias_type;
    const confidence = 0.9;
    if (!fields.alias_value) {
      errors.push("Alias Value is required for add_alias.");
    }
    if (!fields.alias_language || !LANGUAGE_TAG.test(fields.alias_language)) {
      errors.push("Alias Language must be a valid language tag for add_alias.");
    }
    if (!aliasType || !ALIAS_TYPES.has(aliasType)) {
      errors.push("Alias Type is required for add_alias.");
    }

    return {
      type,
      media_id: mediaId,
      alias: {
        value: fields.alias_value,
        language: fields.alias_language,
        type: aliasType,
        source: "community",
        confidence
      },
      evidence_url: fields.evidence_url,
      notes: fields.notes
    };
  }

  if (type === "add_provider_ref") {
    if (!fields.provider || !PROVIDER_KEY.test(fields.provider)) {
      errors.push("Provider must be a stable provider key for add_provider_ref.");
    }
    if (!fields.provider_entity || !PROVIDER_KEY.test(fields.provider_entity)) {
      errors.push("Provider Entity is required for add_provider_ref.");
    }
    if (!fields.provider_id) {
      errors.push("Provider ID is required for add_provider_ref.");
    }

    return {
      type,
      media_id: mediaId,
      provider_ref: {
        provider: fields.provider,
        entity: fields.provider_entity,
        id: fields.provider_id
      },
      evidence_url: fields.evidence_url,
      notes: fields.notes
    };
  }

  if (!fields.metadata_field) {
    errors.push("Metadata Field is required for correct_metadata.");
  }
  if (!fields.metadata_value) {
    errors.push("Metadata Value is required for correct_metadata.");
  }
  if (!fields.provider || !PROVIDER_KEY.test(fields.provider)) {
    errors.push("Provider must be a stable provider key for correct_metadata.");
  }
  if (!fields.source_field) {
    errors.push("Source Field is required for correct_metadata.");
  }

  return {
    type,
    media_id: mediaId,
    field: fields.metadata_field,
    value: parseMetadataValue(fields.metadata_value),
    provenance: {
      source: fields.provider,
      source_field: fields.source_field
    },
    evidence_url: fields.evidence_url,
    notes: fields.notes
  };
}

function isOperationType(value: string | undefined): value is OperationType {
  return value !== undefined && OPERATION_TYPES.has(value as OperationType);
}

function parseMetadataValue(value: string | undefined): unknown {
  if (!value) {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeHeading(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeValue(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized || normalized === NO_RESPONSE) {
    return undefined;
  }
  return normalized;
}

function resolveFromRoot(root: string, path: string): string {
  return isAbsolute(path) ? path : join(root, path);
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

function usage(): string {
  return [
    "Usage:",
    "  github-action parse-issue-event <github-event-path>",
    "  github-action write-approved-contribution <github-event-path> [--out-dir source/contributions/approved] [--force]"
  ].join("\n");
}

async function main(argv: string[]): Promise<void> {
  const [command, eventPath, ...rest] = argv;
  if (!command || !eventPath) {
    throw new CliUsageError(usage());
  }

  const event = JSON.parse(readFileSync(eventPath, "utf8")) as IssueEvent;
  const result = contributionFromIssueEvent(event);
  if (!result.ok) {
    for (const error of result.errors) {
      process.stderr.write(`${error}\n`);
    }
    process.exit(1);
  }

  if (command === "parse-issue-event") {
    process.stdout.write(stableStringify(result.contribution));
    return;
  }

  if (command === "write-approved-contribution") {
    const options = parseWriteOptions(rest);
    const writeResult = writeApprovedContributionRecord(result.contribution, options);
    process.stdout.write(stableStringify({
      file: writeResult.file,
      written: writeResult.written,
      contribution: writeResult.contribution
    }));
    return;
  }

  throw new CliUsageError(`Unknown command: ${command}\n${usage()}`);
}

function parseWriteOptions(args: string[]): WriteApprovedContributionOptions {
  const options: WriteApprovedContributionOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--out-dir") {
      const value = args[index + 1];
      if (!value) {
        throw new CliUsageError("--out-dir requires a path value.");
      }
      options.outDir = value;
      index += 1;
    } else if (arg === "--force") {
      options.force = true;
    } else {
      throw new CliUsageError(`Unknown option: ${arg}`);
    }
  }
  return options;
}

class CliUsageError extends Error {}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  while (args[0] === "--") {
    args.shift();
  }

  main(args).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
