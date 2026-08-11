import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as ort from "onnxruntime-node";

import { parseInstallmentContext } from "@animeatlas/core";

type ModelConfig = {
  max_seq_length?: number;
  id2label: Record<string, string>;
};

type Entity = {
  label: string;
  value: string;
  start: number;
  end: number;
  confidence: number;
};

const MODEL = "ModerRAS/AniFileBERT" as const;
const REVISION = "d8ddb0b54dad4d65a60ab7eba5acb06a2a1fab02" as const;
const root = findRepoRoot(process.cwd());
const assetDir = join(root, "assets", "anifilebert");
const config = JSON.parse(readFileSync(join(assetDir, "config.json"), "utf8")) as ModelConfig;
const vocab = JSON.parse(readFileSync(join(assetDir, "vocab.json"), "utf8")) as Record<string, number>;
const id2label = labelsFromConfig(config.id2label);
const maxLength = config.max_seq_length ?? 128;

const input = process.argv[2] ?? "";
if (!input) throw new Error("AniFileBERT input is required.");
const chars = [...input].slice(0, maxLength - 2);
const inputIds = new BigInt64Array(maxLength);
const attentionMask = new BigInt64Array(maxLength);
inputIds[0] = 2n;
attentionMask[0] = 1n;
for (let index = 0; index < chars.length; index += 1) {
  const char = chars[index];
  inputIds[index + 1] = BigInt(vocab[char] ?? vocab[char.toLowerCase()] ?? 1);
  attentionMask[index + 1] = 1n;
}
inputIds[chars.length + 1] = 3n;
attentionMask[chars.length + 1] = 1n;

const session = await ort.InferenceSession.create(join(assetDir, "anime_filename_parser.onnx"), {
  executionProviders: ["cpu"],
  executionMode: "sequential",
  graphOptimizationLevel: "all",
  intraOpNumThreads: 1,
  interOpNumThreads: 1
});
const outputs = await session.run({
  input_ids: new ort.Tensor("int64", inputIds, [1, maxLength]),
  attention_mask: new ort.Tensor("int64", attentionMask, [1, maxLength])
});
const logits = outputs.logits ?? Object.values(outputs)[0];
if (!logits || logits.dims.length !== 3) throw new Error(`Unexpected AniFileBERT output: ${JSON.stringify(logits?.dims)}`);
const labelCount = logits.dims[2];
const data = logits.data as Float32Array;
const labels: string[] = [];
const confidence: number[] = [];
const decoded = decodeBio(data, chars.length, labelCount, id2label);
for (let position = 1; position <= chars.length; position += 1) {
  const start = position * labelCount;
  const row = data.subarray(start, start + labelCount);
  const selected = decoded[position - 1];
  let max = row[0];
  for (let index = 1; index < row.length; index += 1) if (row[index] > max) max = row[index];
  let denominator = 0;
  for (const value of row) denominator += Math.exp(value - max);
  labels.push(id2label[selected] ?? "O");
  confidence.push(Math.exp(row[selected] - max) / denominator);
}
const entities = collectEntities(chars, labels, confidence);
const titleCandidates = entities
  .filter((entity) => entity.label.startsWith("TITLE_") || entity.label.startsWith("PATH_TITLE_"))
  .map((entity) => ({
    text: entity.value,
    label: entity.label,
    source: entity.label.startsWith("PATH_") ? "path" as const : "file" as const,
    span: [entity.start, entity.end] as [number, number],
    confidence: Number(entity.confidence.toFixed(6))
  }));
const seasonEntity = entities.find((entity) => entity.label === "SEASON" || entity.label === "PATH_SEASON");
const season = seasonEntity ? parseInstallmentContext(seasonEntity.value).season : undefined;
process.stdout.write(`${JSON.stringify({
  model: MODEL,
  revision: REVISION,
  input,
  title_candidates: titleCandidates,
  ...(season === undefined ? {} : { season }),
  ...(seasonEntity ? { season_raw: seasonEntity.value } : {})
})}\n`);

function decodeBio(logits: Float32Array, tokenCount: number, labelCount: number, labels: string[]): number[] {
  let previous = new Float64Array(labelCount).fill(Number.NEGATIVE_INFINITY);
  const backpointers: Int32Array[] = [];
  for (let label = 0; label < labelCount; label += 1) {
    if (!labels[label]?.startsWith("I-")) previous[label] = logits[labelCount + label];
  }

  for (let token = 1; token < tokenCount; token += 1) {
    const next = new Float64Array(labelCount).fill(Number.NEGATIVE_INFINITY);
    const back = new Int32Array(labelCount);
    for (let label = 0; label < labelCount; label += 1) {
      let bestScore = Number.NEGATIVE_INFINITY;
      let bestPrevious = 0;
      for (let prior = 0; prior < labelCount; prior += 1) {
        if (!allowedTransition(labels[prior] ?? "O", labels[label] ?? "O")) continue;
        if (previous[prior] > bestScore) {
          bestScore = previous[prior];
          bestPrevious = prior;
        }
      }
      next[label] = bestScore + logits[(token + 1) * labelCount + label];
      back[label] = bestPrevious;
    }
    backpointers.push(back);
    previous = next;
  }

  let current = 0;
  for (let label = 1; label < labelCount; label += 1) if (previous[label] > previous[current]) current = label;
  const decoded = [current];
  for (let token = backpointers.length - 1; token >= 0; token -= 1) {
    current = backpointers[token][current];
    decoded.push(current);
  }
  return decoded.reverse();
}

function allowedTransition(previous: string, next: string): boolean {
  if (!next.startsWith("I-")) return true;
  const entity = next.slice(2);
  return previous === `B-${entity}` || previous === `I-${entity}`;
}

function labelsFromConfig(labels: Record<string, string>): string[] {
  const result: string[] = [];
  for (const [key, label] of Object.entries(labels)) result[Number(key)] = label;
  return result;
}

function collectEntities(chars: string[], labels: string[], confidences: number[]): Entity[] {
  const entities: Entity[] = [];
  let current: { label: string; chars: string[]; confidence: number[]; start: number } | undefined;
  const flush = (end: number) => {
    if (!current) return;
    const value = current.chars.join("").trim().replace(/^[\[【(]+|[\]】)]+$/g, "").trim();
    if (value) {
      entities.push({
        label: current.label,
        value,
        start: current.start,
        end,
        confidence: current.confidence.reduce((sum, value) => sum + value, 0) / current.confidence.length
      });
    }
    current = undefined;
  };

  for (let index = 0; index < chars.length; index += 1) {
    const match = labels[index].match(/^([BI])-(.+)$/);
    if (!match) {
      flush(index);
      continue;
    }
    const [, prefix, label] = match;
    if (prefix === "B" || current?.label !== label) {
      flush(index);
      current = { label, chars: [], confidence: [], start: index };
    }
    current.chars.push(chars[index]);
    current.confidence.push(confidences[index]);
  }
  flush(chars.length);
  return entities;
}

function findRepoRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`Could not find repository root from ${start}`);
    current = parent;
  }
}
