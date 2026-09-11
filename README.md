# santi-chat

《三体》人物对话 —— 角色扮演 RAG。

**展示页（纯静态，无需后端）**：https://xiaolu-fzu.github.io/santi-chat/
**交互页（完整功能）**：https://santi-chat.pages.dev/chat.html

---

## 亮点：检索全在浏览器里完成

打开交互页会先下载约 32 MB（嵌入模型 + 语料向量），**之后每一次提问的
向量化与相似度检索都在你自己机器上跑**，通常 100 ms 以内。
只有最后"生成回答"这一步联网。

这样做的代价是首次加载慢一点，好处是后端**不需要向量库、不需要嵌入模型**，
代码加起来只有几十 KB —— 任何免费 serverless 都挂得下。

---

## 结构

```
index.html              展示页（预计算的过程记录，不需要后端）
chat.html               交互页
char_demo.js            展示页的数据
fonts/                  自托管中文字体（思源黑体 + JetBrains Mono）
ragdata/
  rag-client.js         浏览器端检索引擎
  vectors.bin           4,722 条语料向量（float16，512 维）
  chunks.json           对应的文本与元数据
  personas.json         手写人设
  manifest.json         清单（维度、条数、角色台词量）
  models/               量化后的嵌入模型（int8 ONNX，22.9 MB）
  ort/                  ONNX Runtime 的 WASM

functions/api/          后端（Cloudflare Pages Functions）
  llm.js                瘦代理：转发 DeepSeek + 计额度
  auth.js               口令校验
  quota.js              额度查询
  persona.js            角色卡生成 / 查询
  persona-states.js     角色锁状态
```

---

## 额度规则

| 项 | 值 |
|---|---|
| 每个角色对话条数 | 10 |
| 每位访客可生成的新角色卡 | 2 张 |
| 已有角色卡（手写或缓存） | 不占额度 |
| 口令 | 见 `ACCESS_CODE`，输入后解除全部限制 |

访客身份靠浏览器 localStorage 里的随机 id。**清缓存可以重置** ——
这只防误触和随手刷，不是安全边界。

---

## 本地开发

```powershell
.\sync.ps1     # 从 RAG 项目同步最新资源
.\dev.ps1      # 构建 dist/ 并启动 wrangler（http://127.0.0.1:8788）
```

`dev.ps1` 需要 `.dev.vars`（从 `.dev.vars.example` 复制一份填好）。
`.dev.vars` 已在 `.gitignore` 里，不会被提交。

---

## 重新部署

```powershell
.\sync.ps1
npx wrangler pages deploy dist --project-name santi-chat --branch main
```

需要环境变量 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。

---

## 数据来源

原著文本《三体》三部曲，切块后 2,082 块；从原文抽取角色台词 2,640 条，
覆盖 31 个角色。
