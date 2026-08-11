import assert from "node:assert/strict";
import test from "node:test";

import {
  Catalog,
  matchEpisodeNumbers,
  parseEpisodeMapping,
  parseInstallmentContext,
  resolveCatalog
} from "./index.js";

const catalog: Catalog = {
  series: [{ id: "series-000001", title: "Tensei Shitara Slime Datta Ken" }],
  media: [
    { id: "media-000001", seriesId: "series-000001", title: "Season 3", installment: { season: 3 } },
    { id: "media-000002", seriesId: "series-000001", title: "Season 4", installment: { season: 4 } }
  ],
  aliases: [{ value: "Tensei Shitara Slime Datta Ken", target: { type: "series", id: "series-000001" } }],
  episodes: [
    {
      id: "episode-000001",
      mediaId: "media-000002",
      providerEpisodeId: "1624224",
      numbers: [
        { namespace: "bangumi:ep", value: 6 },
        { namespace: "bangumi:sort", value: 78 }
      ]
    }
  ]
};

test("season context resolves a shared series alias to one media", () => {
  const result = resolveCatalog(catalog, { titles: ["Tensei Shitara Slime Datta Ken"], season: 4 });
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") assert.equal(result.media.id, "media-000002");
});

test("a shared series alias stays ambiguous without season context", () => {
  assert.equal(resolveCatalog(catalog, { titles: ["Tensei Shitara Slime Datta Ken"] }).status, "ambiguous");
});

test("parses common season, part, and cour text", () => {
  assert.deepEqual(parseInstallmentContext("4th Season Part 2"), { season: 4, part: 2 });
  assert.deepEqual(parseInstallmentContext("第4季 2nd Cour"), { season: 4, cour: 2 });
});

test("06(78) resolves only when both numbers belong to one episode in the target media", () => {
  const parsed = parseEpisodeMapping("06(78)");
  assert.deepEqual(parsed.numbers, [
    { namespace: "release:observed", value: 6 },
    { namespace: "release:observed", value: 78 }
  ]);
  const result = matchEpisodeNumbers("media-000002", parsed, catalog.episodes ?? []);
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") assert.equal(result.episode.providerEpisodeId, "1624224");
});

test("episode matching cannot cross the selected season media", () => {
  assert.equal(matchEpisodeNumbers("media-000001", parseEpisodeMapping("06(78)"), catalog.episodes ?? []).status, "unresolved");
});

test("explicit Bangumi numbers retain their namespaces", () => {
  assert.deepEqual(parseEpisodeMapping("ep=6 sort=78").numbers, [
    { namespace: "bangumi:ep", value: 6 },
    { namespace: "bangumi:sort", value: 78 }
  ]);
});

test("natural local and absolute numbering maps onto provider ep and sort", () => {
  const parsed = parseEpisodeMapping("第6集，总第78集");
  assert.deepEqual(parsed.numbers, [
    { namespace: "series:absolute", value: 78 },
    { namespace: "media:local", value: 6 }
  ]);
  assert.equal(matchEpisodeNumbers("media-000002", parsed, catalog.episodes ?? []).status, "resolved");
});
