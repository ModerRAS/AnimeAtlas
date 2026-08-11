import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CatalogEpisode,
  EpisodeNumber,
  matchEpisodeNumbers,
  normalizeAlias,
  parseEpisodeMapping,
  parseInstallmentContext
} from "@animeatlas/core";

import { AniFileBertObservation, observeWithAniFileBert } from "./anifilebert.js";

export type ContributionV2Record = {
  schema: "contribution/v2";
  issue: { number: number; url: string; author: string };
  observation: {
    alias?: string;
    example?: string;
    season_part?: string;
    episode_mapping?: string;
    metadata_field?: string;
    metadata_value?: string;
    notes?: string;
    parser?: AniFileBertObservation;
    parsed_installment: { season?: number; part?: number; cour?: number };
  };
  target: {
    series_id: string;
    media_id: string;
    title: string;
    installment: { season?: number; part?: number; cour?: number };
    provider_ref: { provider: "bangumi"; entity: "subject"; id: string };
  };
  changes: Array<Record<string, unknown> & { type: "add_media_alias" | "upsert_episode_numbers" | "correct_metadata" }>;
  review: { approved_by: string; approved_at: string };
};

export type V2ParseResult =
  | { ok: true; contribution: ContributionV2Record }
  | { ok: false; errors: string[] };

type IssueEvent = {
  issue?: {
    number?: number;
    html_url?: string;
    user?: { login?: string };
    updated_at?: string;
  };
  sender?: { login?: string };
};

type MediaRecord = {
  schema?: string;
  id?: string;
  series_id?: string;
  title?: string;
  installment?: { season?: number; part?: number; cour?: number };
  provider_refs?: Array<{ provider?: string; entity?: string; id?: string }>;
};

type EpisodeRecord = {
  media_id?: string;
  episodes?: Array<{
    id?: string;
    provider_refs?: Array<{ provider?: string; entity?: string; id?: string }>;
    numbers?: Array<{ namespace?: string; value?: number; source?: string }>;
  }>;
};

export function contributionV2FromIssueFields(
  event: IssueEvent,
  fields: Record<string, string>,
  root: string
): V2ParseResult {
  const errors: string[] = [];
  const alias = fields.name_that_should_resolve?.trim();
  const metadataField = fields.metadata_field?.trim();
  const metadataValue = fields.correct_value?.trim();
  const isMetadataCorrection = metadataField !== undefined;
  const correctAnime = fields.correct_anime?.trim();
  if (!alias && !isMetadataCorrection) errors.push("Name That Should Resolve is required.");
  if (isMetadataCorrection && !metadataValue) errors.push("Correct Value is required for a metadata correction.");
  if (isMetadataCorrection && !fields.evidence_url) errors.push("Evidence URL is required for a metadata correction.");
  if (!correctAnime) errors.push("Correct Anime is required.");

  const subjectId = correctAnime ? bangumiSubjectId(correctAnime) : undefined;
  if (correctAnime && !subjectId) errors.push("Correct Anime must contain a Bangumi subject URL or numeric subject ID.");

  const media = subjectId ? findBangumiMedia(root, subjectId) : undefined;
  if (subjectId && !media) errors.push(`Bangumi subject ${subjectId} is not linked to a catalog media.`);
  if (media?.schema !== "media-identity/v2" || !media.series_id || !media.id || !media.title || !media.installment) {
    if (media) errors.push(`Target ${media.id ?? subjectId} has not been migrated to season-aware media-identity/v2.`);
  }

  const explicitInstallment = parseInstallmentContext(fields.season_part ?? "");
  const observedInstallment = parseInstallmentContext(`${alias ?? ""} ${fields.example_filename_or_path ?? ""}`);
  let parserObservation: AniFileBertObservation | undefined;
  const parserInput = fields.example_filename_or_path?.trim() || alias;
  if (parserInput && !isMetadataCorrection) {
    try {
      parserObservation = observeWithAniFileBert(parserInput);
    } catch (error) {
      errors.push(`AniFileBERT failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (parserObservation?.season !== undefined && observedInstallment.season !== undefined && parserObservation.season !== observedInstallment.season) {
    errors.push(`AniFileBERT season=${parserObservation.season} conflicts with observed marker season=${observedInstallment.season}.`);
  }
  for (const key of ["season", "part", "cour"] as const) {
    const explicit = explicitInstallment[key];
    const observed = observedInstallment[key];
    const target = media?.installment?.[key];
    if (explicit !== undefined && observed !== undefined && explicit !== observed) {
      errors.push(`Season/Part input ${key}=${explicit} conflicts with observed name/path ${key}=${observed}.`);
    }
    const submitted = explicit ?? (key === "season" ? parserObservation?.season : undefined) ?? observed;
    if (submitted !== undefined && target !== undefined && submitted !== target) {
      errors.push(`Submitted ${key}=${submitted} does not match target media ${key}=${target}.`);
    }
  }

  const changes: ContributionV2Record["changes"] = [];
  if (alias && media?.id && !isMetadataCorrection) {
    const existingTargets = aliasTargets(root, alias);
    if (!existingTargets.has(media.id)) {
      changes.push({
        type: "add_media_alias",
        media_id: media.id,
        alias: {
          value: alias,
          language: "und",
          type: "alternative",
          source: "community",
          confidence: 1
        }
      });
    }
  }

  const episodeInput = fields.episode_mapping?.trim();
  if (episodeInput && media?.id) {
    const parsed = parseEpisodeMapping(episodeInput);
    if (parsed.numbers.length === 0) {
      errors.push("Episode Mapping does not contain a recognizable episode number.");
    } else {
      const episodes = readCatalogEpisodes(root, media.id);
      const match = matchEpisodeNumbers(media.id, parsed, episodes);
      if (match.status === "unresolved") {
        errors.push("Episode Mapping does not match one episode inside the selected Season media.");
      } else if (match.status === "ambiguous") {
        errors.push("Episode Mapping matches more than one episode inside the selected Season media.");
      } else {
        changes.push({
          type: "upsert_episode_numbers",
          media_id: media.id,
          episode_id: match.episode.id,
          provider_episode_id: match.episode.providerEpisodeId,
          raw: parsed.raw,
          numbers: parsed.numbers.map((number) => ({ ...number, source: `github-issue:${event.issue?.number ?? 0}` }))
        });
      }
    }
  }

  if (metadataField && metadataValue && media?.id) {
    if (!metadataField.startsWith("metadata.")) {
      errors.push("Metadata Field must use a metadata.* path.");
    } else {
      changes.push({
        type: "correct_metadata",
        media_id: media.id,
        field: metadataField,
        value: parseScalar(metadataValue),
        provenance: {
          source: "community",
          source_field: "github-issue",
          evidence_url: fields.evidence_url
        }
      });
    }
  }

  if (changes.length === 0 && errors.length === 0) errors.push("The requested change is already present.");
  if (!event.issue?.number || !event.issue.html_url || !event.issue.user?.login || !event.issue.updated_at || !event.sender?.login) {
    errors.push("Issue number, URL, author, approver, and updated_at are required.");
  }
  if (errors.length > 0 || !media?.id || !media.series_id || !media.title || !media.installment || !subjectId || (!alias && !isMetadataCorrection)) {
    return { ok: false, errors };
  }

  const parsedInstallment = {
    ...observedInstallment,
    ...(parserObservation?.season === undefined ? {} : { season: parserObservation.season }),
    ...explicitInstallment
  };
  return {
    ok: true,
    contribution: {
      schema: "contribution/v2",
      issue: {
        number: event.issue!.number as number,
        url: event.issue!.html_url as string,
        author: event.issue!.user?.login as string
      },
      observation: {
        ...(alias ? { alias } : {}),
        ...(fields.example_filename_or_path ? { example: fields.example_filename_or_path } : {}),
        ...(fields.season_part ? { season_part: fields.season_part } : {}),
        ...(episodeInput ? { episode_mapping: episodeInput } : {}),
        ...(metadataField ? { metadata_field: metadataField } : {}),
        ...(metadataValue ? { metadata_value: metadataValue } : {}),
        ...(fields.additional_context ? { notes: fields.additional_context } : {}),
        ...(parserObservation ? { parser: parserObservation } : {}),
        parsed_installment: parsedInstallment
      },
      target: {
        series_id: media.series_id,
        media_id: media.id,
        title: media.title,
        installment: media.installment,
        provider_ref: { provider: "bangumi", entity: "subject", id: subjectId }
      },
      changes,
      review: {
        approved_by: event.sender?.login as string,
        approved_at: event.issue!.updated_at as string
      }
    }
  };
}

function parseScalar(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function bangumiSubjectId(value: string): string | undefined {
  const urlMatch = value.match(/(?:bgm\.tv|bangumi\.tv)\/subject\/(\d+)/i);
  if (urlMatch) return urlMatch[1];
  return /^\d+$/.test(value.trim()) ? value.trim() : undefined;
}

function findBangumiMedia(root: string, subjectId: string): MediaRecord | undefined {
  for (const file of jsonFiles(join(root, "db", "media"))) {
    const media = JSON.parse(readFileSync(file, "utf8")) as MediaRecord;
    if (media.provider_refs?.some((ref) => ref.provider === "bangumi" && ref.entity === "subject" && ref.id === subjectId)) {
      return media;
    }
  }
  return undefined;
}

function aliasTargets(root: string, value: string): Set<string> {
  const normalized = normalizeAlias(value);
  const targets = new Set<string>();
  for (const file of jsonFiles(join(root, "db", "aliases"))) {
    const record = JSON.parse(readFileSync(file, "utf8")) as { media_id?: string; aliases?: Array<{ value?: string }> };
    if (!record.media_id) continue;
    if (record.aliases?.some((alias) => typeof alias.value === "string" && normalizeAlias(alias.value) === normalized)) {
      targets.add(record.media_id);
    }
  }
  return targets;
}

function readCatalogEpisodes(root: string, mediaId: string): CatalogEpisode[] {
  const file = join(root, "db", "episodes", `${mediaId}.json`);
  if (!existsSync(file)) return [];
  const record = JSON.parse(readFileSync(file, "utf8")) as EpisodeRecord;
  return (record.episodes ?? []).flatMap((episode) => {
    if (!episode.id) return [];
    const providerEpisodeId = episode.provider_refs?.find((ref) => ref.provider === "bangumi" && ref.entity === "episode")?.id;
    const numbers: EpisodeNumber[] = (episode.numbers ?? []).flatMap((number) =>
      typeof number.namespace === "string" && Number.isInteger(number.value)
        ? [{ namespace: number.namespace, value: number.value as number }]
        : []
    );
    return [{ id: episode.id, mediaId, ...(providerEpisodeId ? { providerEpisodeId } : {}), numbers }];
  });
}

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(dir, name));
}
