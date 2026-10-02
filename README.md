# AnimeAtlas

[![Validate](https://github.com/ModerRAS/AnimeAtlas/actions/workflows/validate.yml/badge.svg)](https://github.com/ModerRAS/AnimeAtlas/actions/workflows/validate.yml)
[![Download SQLite](https://img.shields.io/badge/download-animeatlas.sqlite-00897B)](https://github.com/ModerRAS/AnimeAtlas/releases/download/download/animeatlas.sqlite)

[中文](README.md) | [English](README.en.md)

面向离线查询的开放动漫身份与元数据数据库。

AnimeAtlas 将动漫名称与外部数据源 ID 解析为稳定的 `series -> media -> episode` 身份链。media 记录带有经过校验的 Season/Part 上下文，剧集编号保留 `bangumi:ep`、`bangumi:sort` 等数据源命名空间。

## 下载数据库

单文件 SQLite 快照通过**固定下载链接**发布，始终指向最新构建——链接在版本之间保持不变：

```
https://github.com/ModerRAS/AnimeAtlas/releases/download/download/animeatlas.sqlite
```

```bash
curl -L -o animeatlas.sqlite \
  https://github.com/ModerRAS/AnimeAtlas/releases/download/download/animeatlas.sqlite
```

`download` release 是稳定别名。每次发布同时创建不可变的语义化版本 release，包含 `animeatlas-<version>.sqlite` 与 SHA-256 清单。确切的 catalog、SQLite schema、generator、normalization 与 parser 修订号都记录在 `release_info` 中：

```sql
SELECT key, value FROM release_info ORDER BY key;
```

### SQLite schema

```text
series                 (id, title, relationships_json)
media                  (id, series_id, season_number, part_number, cour_number, metadata_json, provenance_json)
series_aliases         (series_id, value, normalized, language, type, source, confidence)
aliases                (media_id, value, normalized, language, type, source, confidence)
provider_refs          (media_id, provider, entity, provider_id, provider_key)
episodes               (id, media_id, kind, provenance_json)
episode_provider_refs  (episode_id, provider, entity, provider_id)
episode_numbers        (episode_id, namespace, number_value, source)
search_tokens           (token, media_id)
release_info            (key, value)
```

别名构成候选集合；同一 normalized 别名在不同 installment 之间重复是合法的。`aliases_v1_compat` 只暴露可唯一解析到单个 media 的别名。每集只属于一个 media，从而保证带命名空间的编号不会静默跨季。

### 查询示例

```sql
-- 解析别名。`normalized` 存储 NFKC + trim + 小写后的文本。
SELECT m.id, m.title
FROM aliases a JOIN media m ON m.id = a.media_id
WHERE a.normalized = 'sousou no frieren';

-- 通过 Bangumi subject ID 查询 media 身份。
SELECT m.id, m.title, m.summary
FROM provider_refs p JOIN media m ON m.id = p.media_id
WHERE p.provider = 'bangumi' AND p.entity = 'subject' AND p.provider_id = '400602';

-- 取出某个 media 身份的规范化元数据及其 provenance。
SELECT metadata_json, provenance_json FROM media WHERE id = 'media-000001';
```

## 使用 CLI

仓库还提供 CLI，可基于已提交的 JSON 索引离线解析（无需网络）。

环境要求：Node.js 22+、pnpm 10+。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

从本地索引解析标题/别名或外部数据源 ID：

```bash
pnpm cli -- resolve alias "Tensei Shitara Slime Datta Ken" --season 4
pnpm cli -- resolve provider bangumi subject 515594
```

两者都会返回带类型的 `resolved`、`ambiguous` 或 `unresolved` 结果。别名解析读取候选集合索引，并接受 `--season`、`--part`、`--cour`。加 `--compact` 输出单行 JSON。

| 命令 | 用途 |
| --- | --- |
| `resolve alias <title> [--season N]` | 结合 installment 上下文解析候选集合 |
| `resolve provider <provider> <entity> <id>` | 将外部数据源 ID 映射为 media 身份 |
| `bangumi plan-archive <file>` | 规划从 Bangumi archive dump 批量导入 |
| `contributions plan-approved` | 预览已批准 contribution issue 产生的变更 |
| `contributions apply-approved --write` | 将已批准 contribution 应用到 `db/` |

## 数据库内容

已提交的快照是种子数据集，整合了各数据源的 ID，并携带带字段级 provenance 的规范化元数据（每个值来自哪个数据源、哪个来源字段、哪条规则）。它通过经过审核的社区贡献持续增长。当前记录数量（media、aliases、provider refs、search tokens）见 `generated/stats/summary.json`。

## 数据模型

```text
reviewed source inputs
        |
        v
source/  ->  db/  ->  generated/  ->  SQLite release
                  ^
           normalized records
```

| 目录 | 用途 | 编辑策略 |
| --- | --- | --- |
| `source/` | 已批准的社区贡献、导入清单与持久化编辑决策 | 通过受审核的工作流创建 |
| `raw/` | 可选的已采集数据源证据 | 仅机器写入 |
| `db/` | 规范化后的 media、别名、元数据、关系与 provenance 记录 | 由导入流水线生成 |
| `generated/` | 确定性查找索引、清单与统计 | 运行 `pnpm generate`；禁止手动编辑 |
| `apps/` | CLI、GitHub Action 辅助程序与静态查看器 | 应用入口 |
| `packages/` | Schema、数据源契约、importer、validator 与 generator | 可复用领域逻辑 |

`generated/` 是可丢弃的输出。`source/` 与数据源证据说明已发布快照是如何产生的；`db/` 是稳定的 JSON 消费层。

## 贡献数据

不要直接编辑数据库 JSON。请使用 Recognition 或 Season/episode 的 issue 表单。贡献者填写自然语言的观察结果与 Bangumi 目标；自动化会在批准前校验 Season 归属，并把 `06(78)` 之类的可选文本转换为带类型的剧集编号变更。

1. 维护者审核结构化 issue 并打上 `approved` 标签。
2. GitHub Actions 解析 contribution，通过 importer 应用，重新生成索引并运行 `pnpm check`。
3. 成功后，自动化将更新后的 `source/`、`db/`、`generated/` 记录提交到 `master`，关闭 issue，并刷新 `download` SQLite release。

批准标签即写入闸门。社区输入在影响规范化数据之前，会先以可审计的 contribution 记录形式保存。

## 开发

| 命令 | 用途 |
| --- | --- |
| `pnpm check` | 构建、类型检查、校验数据、验证生成产物并运行冒烟检查 |
| `pnpm validate` | 校验 source 与规范化记录 |
| `pnpm generate` | 从 `db/` 重建确定性索引与清单 |
| `pnpm check:generated` | 当已提交的生成产物过期时失败 |
| `pnpm cli -- contributions plan-approved` | 预览已批准 contribution 的变更（不写文件） |
| `pnpm cli -- contributions apply-approved --write` | 在本地应用已批准 contribution |
| `pnpm release:sqlite` | 构建稳定与不可变 SQLite 产物及 SHA-256 清单 |
| `pnpm migrate:v2` | 审计所有 `db/migrations/v2-*.json` 计划；加 `-- --refresh` 采集实时证据，或加 `-- --write` 应用缓存证据 |
| `pnpm audit:v2` | 缓存并分类剩余 v1 Bangumi subjects、relations 与分页 regular episodes |
| `pnpm replay:library` | 将 v1/v2 与只读 `library.db` 中存储的路径进行对比 |

提交数据或 schema 变更前请运行 `pnpm check`。它与仓库自动化使用同一套校验闸门。

## 架构

- [AnimeAtlas v2 catalog](docs/v2-catalog.md)
- [架构总览](docs/architecture.md)
- [仓库边界](docs/repository-architecture.md)
- [Schema-first 设计](docs/schema-first-architecture.md)
- [校验与索引生成](docs/validation-and-index-generation.md)
- [GitHub 自动化](.github/README.md)

## 许可证

[MIT](LICENSE)
