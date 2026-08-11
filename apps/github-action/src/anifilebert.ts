import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export type AniFileBertObservation = {
  model: "ModerRAS/AniFileBERT";
  revision: "d8ddb0b54dad4d65a60ab7eba5acb06a2a1fab02";
  input: string;
  title_candidates: Array<{
    text: string;
    label: string;
    source: "file" | "path";
    span: [number, number];
    confidence: number;
  }>;
  season?: number;
  season_raw?: string;
};

export function observeWithAniFileBert(input: string): AniFileBertObservation {
  const worker = fileURLToPath(new URL("./anifilebert-worker.js", import.meta.url));
  const output = execFileSync(process.execPath, [worker, input], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 30_000
  });
  return JSON.parse(output) as AniFileBertObservation;
}
