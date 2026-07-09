import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { stableStringify } from "@animeatlas/core";

type ProviderRef = {
  provider: string;
  entity: string;
  id: string;
};

type IdentityRecord = {
  id: string;
  kind: string;
  provider_refs: ProviderRef[];
};

type AliasRecord = {
  media_id: string;
  aliases: Array<{
    value: string;
    language?: string;
    type?: string;
    source?: string;
    confidence?: number;
  }>;
};

type MetadataRecord = {
  media_id: string;
  metadata: Record<string, unknown>;
  _meta?: {
    last_sync?: Record<string, string>;
    fields?: Record<string, unknown>;
  };
};

type GeneratedIndex = {
  entries: Record<string, string>;
};

type ViewerMedia = {
  id: string;
  kind: string;
  title: string;
  summary: string | null;
  aliases: AliasRecord["aliases"];
  provider_refs: ProviderRef[];
  metadata: Record<string, unknown>;
  provenance_fields: string[];
  last_sync: Record<string, string>;
};

type ViewerData = {
  schema: "animeatlas-viewer-data/v1";
  stats: unknown;
  build_manifest: unknown;
  index_counts: {
    alias_entries: number;
    provider_id_entries: number;
  };
  media: ViewerMedia[];
};

export function buildViewer(root = findRepoRoot()): ViewerData {
  const data = buildViewerData(root);
  const outDir = join(root, "apps/viewer/dist/public");
  const dataJson = stableStringify(data);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "data.json"), `${dataJson}\n`);
  writeFileSync(join(outDir, "index.html"), buildViewerHtml(dataJson));

  return data;
}

export function buildViewerData(root = findRepoRoot()): ViewerData {
  const identities = listJsonFiles(join(root, "db/media")).map((file) => readJson<IdentityRecord>(file));
  const aliases = new Map(
    listJsonFiles(join(root, "db/aliases")).map((file) => {
      const record = readJson<AliasRecord>(file);
      return [record.media_id, record] as const;
    })
  );
  const metadata = new Map(
    listJsonFiles(join(root, "db/metadata")).map((file) => {
      const record = readJson<MetadataRecord>(file);
      return [record.media_id, record] as const;
    })
  );
  const aliasIndex = readJson<GeneratedIndex>(join(root, "generated/indexes/aliases/exact.json"));
  const providerIndex = readJson<GeneratedIndex>(join(root, "generated/indexes/provider-ids/exact.json"));

  return {
    schema: "animeatlas-viewer-data/v1",
    stats: readJson(join(root, "generated/stats/summary.json")),
    build_manifest: readJson(join(root, "generated/manifests/build.json")),
    index_counts: {
      alias_entries: Object.keys(aliasIndex.entries).length,
      provider_id_entries: Object.keys(providerIndex.entries).length
    },
    media: identities
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((identity) => {
        const aliasRecord = aliases.get(identity.id);
        const metadataRecord = metadata.get(identity.id);
        const normalized = metadataRecord?.metadata ?? {};
        const title = stringValue(normalized.title) ?? aliasRecord?.aliases[0]?.value ?? identity.id;
        const summary = stringValue(normalized.summary);

        return {
          id: identity.id,
          kind: identity.kind,
          title,
          summary,
          aliases: aliasRecord?.aliases ?? [],
          provider_refs: [...identity.provider_refs].sort(compareProviderRef),
          metadata: normalized,
          provenance_fields: Object.keys(metadataRecord?._meta?.fields ?? {}).sort(),
          last_sync: metadataRecord?._meta?.last_sync ?? {}
        };
      })
  };
}

export function findRepoRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Could not find repository root from ${start}`);
    }
    current = parent;
  }
}

function listJsonFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(dir, name));
}

function readJson<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function compareProviderRef(a: ProviderRef, b: ProviderRef): number {
  return `${a.provider}:${a.entity}:${a.id}`.localeCompare(`${b.provider}:${b.entity}:${b.id}`);
}

function buildViewerHtml(dataJson: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AnimeAtlas Viewer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --ink: #14171f;
      --muted: #687080;
      --line: #d9dee8;
      --accent: #0b6bcb;
      --green: #287348;
      --amber: #8a5a00;
      --chip: #eef2f7;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 16px 24px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 20px; font-weight: 700; letter-spacing: 0; }
    h2 { font-size: 16px; margin-bottom: 12px; }
    h3 { font-size: 14px; margin: 18px 0 8px; }
    main {
      display: grid;
      grid-template-columns: minmax(280px, 420px) minmax(0, 1fr);
      min-height: calc(100vh - 65px);
    }
    aside, section { padding: 18px 24px; }
    aside {
      border-right: 1px solid var(--line);
      background: var(--panel);
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      min-width: 360px;
    }
    .stat {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 10px;
      background: #fbfcfe;
    }
    .stat strong { display: block; font-size: 18px; }
    .stat span { color: var(--muted); font-size: 12px; }
    input {
      width: 100%;
      height: 40px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 12px;
      font: inherit;
      color: var(--ink);
      background: #fff;
    }
    .list {
      display: grid;
      gap: 8px;
      margin-top: 14px;
    }
    .row {
      width: 100%;
      min-height: 74px;
      display: grid;
      gap: 4px;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: inherit;
      text-align: left;
      font: inherit;
      cursor: pointer;
    }
    .row[aria-current="true"] { border-color: var(--accent); box-shadow: inset 3px 0 0 var(--accent); }
    .row-title { font-weight: 700; }
    .row-meta, .muted { color: var(--muted); font-size: 13px; }
    .detail {
      max-width: 1040px;
    }
    .title-line {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 10px;
    }
    .media-id { color: var(--accent); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; }
    .summary { color: #303541; line-height: 1.5; max-width: 760px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      margin-top: 18px;
    }
    .panel {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      padding: 14px;
      min-width: 0;
    }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .chip {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      border-radius: 6px;
      padding: 3px 8px;
      background: var(--chip);
      color: #273142;
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    .chip.provider { background: #e9f3ff; color: #174f86; }
    .chip.sync { background: #ecf7ef; color: var(--green); }
    .chip.field { background: #fff5df; color: var(--amber); }
    dl {
      display: grid;
      grid-template-columns: 150px minmax(0, 1fr);
      gap: 8px 12px;
      margin: 0;
      font-size: 14px;
    }
    dt { color: var(--muted); }
    dd { margin: 0; overflow-wrap: anywhere; }
    @media (max-width: 760px) {
      header { align-items: stretch; flex-direction: column; }
      main { grid-template-columns: 1fr; }
      aside { border-right: 0; border-bottom: 1px solid var(--line); }
      .stats, .grid { grid-template-columns: 1fr; min-width: 0; }
      dl { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <script type="application/json" id="viewer-data">${escapeHtml(dataJson)}</script>
  <header>
    <h1>AnimeAtlas Viewer</h1>
    <div class="stats" id="stats"></div>
  </header>
  <main>
    <aside>
      <input id="search" type="search" autocomplete="off" placeholder="Search">
      <div class="list" id="media-list"></div>
    </aside>
    <section class="detail" id="detail"></section>
  </main>
  <script>
    const data = JSON.parse(document.getElementById("viewer-data").textContent);
    const byId = new Map(data.media.map((item) => [item.id, item]));
    let selectedId = data.media[0]?.id ?? null;
    let query = "";

    const stats = document.getElementById("stats");
    const list = document.getElementById("media-list");
    const detail = document.getElementById("detail");
    const search = document.getElementById("search");

    search.addEventListener("input", () => {
      query = search.value.trim().toLowerCase();
      renderList();
    });

    function renderStats() {
      stats.replaceChildren(
        stat(data.media.length, "media"),
        stat(data.index_counts.alias_entries, "aliases"),
        stat(data.index_counts.provider_id_entries, "provider IDs")
      );
    }

    function stat(value, label) {
      const node = document.createElement("div");
      node.className = "stat";
      const strong = document.createElement("strong");
      strong.textContent = String(value);
      const span = document.createElement("span");
      span.textContent = label;
      node.append(strong, span);
      return node;
    }

    function renderList() {
      const rows = data.media.filter((item) => matches(item, query));
      list.replaceChildren(...rows.map((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "row";
        button.setAttribute("aria-current", item.id === selectedId ? "true" : "false");
        button.addEventListener("click", () => {
          selectedId = item.id;
          renderList();
          renderDetail();
        });

        const title = document.createElement("span");
        title.className = "row-title";
        title.textContent = item.title;
        const meta = document.createElement("span");
        meta.className = "row-meta";
        meta.textContent = item.id + " / " + item.provider_refs.length + " refs";
        button.append(title, meta);
        return button;
      }));
    }

    function matches(item, value) {
      if (!value) return true;
      const providerRefs = item.provider_refs.map((ref) => ref.provider + ":" + ref.entity + ":" + ref.id).join(" ");
      const aliases = item.aliases.map((alias) => alias.value).join(" ");
      return [item.id, item.title, item.summary, aliases, providerRefs].join(" ").toLowerCase().includes(value);
    }

    function renderDetail() {
      const item = byId.get(selectedId);
      if (!item) {
        detail.replaceChildren();
        return;
      }

      const root = document.createElement("div");
      const titleLine = document.createElement("div");
      titleLine.className = "title-line";
      const title = document.createElement("h2");
      title.textContent = item.title;
      const id = document.createElement("span");
      id.className = "media-id";
      id.textContent = item.id;
      titleLine.append(title, id);

      const summary = document.createElement("p");
      summary.className = "summary";
      summary.textContent = item.summary ?? "";

      const grid = document.createElement("div");
      grid.className = "grid";
      grid.append(
        panel("Aliases", chips(item.aliases.map((alias) => alias.value + " / " + (alias.language ?? "und")))),
        panel("Provider refs", chips(item.provider_refs.map((ref) => ref.provider + ":" + ref.entity + ":" + ref.id), "provider")),
        panel("Metadata", metadataList(item.metadata)),
        panel("Provenance", provenance(item))
      );

      root.append(titleLine, summary, grid);
      detail.replaceChildren(root);
    }

    function panel(title, content) {
      const node = document.createElement("div");
      node.className = "panel";
      const heading = document.createElement("h3");
      heading.textContent = title;
      node.append(heading, content);
      return node;
    }

    function chips(values, extraClass = "") {
      const box = document.createElement("div");
      box.className = "chips";
      box.replaceChildren(...values.map((value) => {
        const chip = document.createElement("span");
        chip.className = ("chip " + extraClass).trim();
        chip.textContent = value;
        return chip;
      }));
      return box;
    }

    function metadataList(metadata) {
      const list = document.createElement("dl");
      for (const [key, value] of Object.entries(metadata)) {
        const dt = document.createElement("dt");
        dt.textContent = key;
        const dd = document.createElement("dd");
        dd.textContent = typeof value === "object" ? JSON.stringify(value) : String(value);
        list.append(dt, dd);
      }
      return list;
    }

    function provenance(item) {
      const box = document.createElement("div");
      const sync = chips(Object.entries(item.last_sync).map(([provider, value]) => provider + " " + value), "sync");
      const fields = chips(item.provenance_fields, "field");
      box.append(sync, fields);
      return box;
    }

    renderStats();
    renderList();
    renderDetail();
  </script>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const mainModuleUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";

if (import.meta.url === mainModuleUrl) {
  const data = buildViewer();
  console.log(`Built viewer with ${data.media.length} media records.`);
}
