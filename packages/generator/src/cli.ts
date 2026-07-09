import { checkGeneratedFiles, writeGeneratedFiles } from "./index.js";

const mode = process.argv[2] ?? "--write";

if (mode === "--check") {
  const result = checkGeneratedFiles();
  if (!result.ok) {
    for (const mismatch of result.mismatches) {
      console.error(mismatch);
    }
    process.exit(1);
  }
  console.log("Generated artifacts are up to date.");
} else if (mode === "--write") {
  const written = writeGeneratedFiles();
  console.log(`Wrote ${written.length} generated artifacts.`);
} else {
  console.error(`Unknown mode: ${mode}`);
  process.exit(1);
}
