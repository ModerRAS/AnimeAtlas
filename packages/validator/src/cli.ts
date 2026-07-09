import { validateRepository } from "./index.js";

const result = validateRepository();

if (!result.ok) {
  for (const issue of result.issues) {
    console.error(`${issue.file}: ${issue.message}`);
  }
  process.exit(1);
}

console.log(
  `Validated ${result.counts.providers} providers, ${result.counts.contributions} approved contributions, ${result.counts.media} media identities, ${result.counts.aliases} alias records, and ${result.counts.metadata} metadata records.`
);
