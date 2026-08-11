# AniFileBERT Runtime Assets

Pinned from `ModerRAS/AniFileBERT` commit
`d8ddb0b54dad4d65a60ab7eba5acb06a2a1fab02`.

| File | SHA-256 |
| --- | --- |
| `anime_filename_parser.onnx` | `b3b1fe856497f8484b1f5d708295bbb578fbecb2693f9e83a09df2409714d7eb` |
| `config.json` | `87ffd5aa669c4d14af50edeb6d514ea6b6f51eb884a5011dd4e9cdfab17dbfb4` |
| `vocab.json` | `11e98a98d321f0d04dd845215a00f754de466fbebf3e2b1911f51ca4ce76b15b` |

The ONNX graph contains logits only. `apps/github-action` supplies the pinned
character tokenizer, entity aggregation, and title/Season observation contract.
Episode-number normalization remains in AnimeAtlas core and uses the human Issue
field plus provider episode rows.
