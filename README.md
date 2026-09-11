# santi-chat

《三体》人物对话 —— 角色扮演 RAG 的在线版。

**检索全在浏览器里完成**：下载一次嵌入模型和语料向量（约 32 MB，之后走缓存），
之后每一次提问的向量化与相似度检索都在你自己机器上跑。
只有最后"生成回答"这一步联网。

---

## 结构

```
public/                 静态资源（Cloudflare Pages 直接托管）
  index.html            展示页（预计算的过程记录，不需要后端）
  chat.html             交互页
  char_demo.js          展示页的数据
  fonts/                自托管中文字体（思源黑体 + JetBrains Mono）
  ragdata/
    rag-client.js       浏览器端检索引擎
    vectors.bin         4,722 条语料向量（float16，512 维）
    chunks.json         对应的文本与元数据
    personas.json       手写人设
    manifest.json       清单（维度、条数、角色台词量）
    models/             量化后的嵌入模型（int8 ONNX）
    ort/                ONNX Runtime 的 WASM

functions/api/          后端（Cloudflare Pages Functions）
  llm.js                瘦代理：转发 DeepSeek + 计额度
  auth.js               口令校验
  quota.js              额度查询
  persona.js            角色卡生成 / 查询
  persona-states.js     角色锁状态
```

后端**不存向量、不装模型**，代码加起来几十 KB。

---

## 部署步骤

### 1. 创建 KV 命名空间

Cloudflare 控制台 → **Storage & Databases** → **KV** → **Create namespace**
名字随便，比如 `santi`。

创建完把它前面的 **ID** 复制出来，填进 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "SANTI"
id = "这里粘贴你的 KV ID"
```

### 2. 创建 Pages 项目

控制台 → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
选这个仓库，构建设置：

| 项 | 值 |
|---|---|
| Framework preset | None |
| Build command | 留空 |
| Build output directory | `public` |

### 3. 配置环境变量

项目创建后 → **Settings** → **Variables and Secrets**，加两个：

| 名称 | 值 | 类型 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 你的 DeepSeek key | **Secret**（加密） |
| `ACCESS_CODE` | `LJH` | Secret |

再确认 **Settings → Functions → KV namespace bindings** 里有
`SANTI` 指向你创建的命名空间。

### 4. 重新部署

改完环境变量要 **Retry deployment** 才会生效。

---

## 本地开发

```bash
npx wrangler pages dev public
```

它会读 `.dev.vars`（从 `.dev.vars.example` 复制一份填好）。

同步 RAG 项目里的最新资源：

```powershell
.\sync.ps1
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
