/* ============================================================
 * 浏览器端检索引擎（路径 B）
 *
 * 把原本跑在 Python 服务端的检索搬到浏览器：
 *   1. 下载量化嵌入模型（约 23MB，之后走缓存）
 *   2. 下载预计算好的语料向量与文本
 *   3. 提问时：本地嵌入 → 本地余弦检索 → 组装 prompt
 *   4. 只有"生成回答"这一步走网络（通过瘦代理转发大模型）
 *
 * 与 Python 版严格对齐的几点：
 *   - 距离度量是【余弦距离】：向量已归一化，distance = 1 - 点积
 *   - 角色台词只在该角色的向量里检索，取前 4 条
 *   - 剧情检索取前 3 块，再做相邻块扩展（前后各 1 块），去重后约 8 块
 * ============================================================ */
/* 推理库优先用【本站自托管】的那份。
   之前依赖 CDN，网络一抖就整个打不开 —— 而且实测 ORT 的 WASM 也会
   跟着去 CDN 拿，等于把两个最关键的依赖都押在第三方上。
   自托管后，除了最后生成回答，整个页面不再请求任何外部域名。 */
const CDNS = [   // 仅当自托管那份缺失时的兜底
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5',
];
const MODEL_ID = 'bge-small-zh-v1.5';
/* 资源根目录。用 import.meta.url 推导成【绝对 URL】：
   - fetch() 相对的是页面
   - dynamic import() 相对的是本模块
   - ONNX Runtime 解析 wasmPaths 又是另一套规则
   只有绝对 URL 能同时满足这三者，也才能兼容 GitHub Pages 的 /santi-chat/ 子路径。 */
const DATA = new URL('./', import.meta.url).href;
const VOICE_K = 4;
const PLOT_K = 3;
const NEIGHBOR_WINDOW = 1;

let extractor = null, V = null, RECS = null, MANIFEST = null, PERSONAS = null;

/* ---------- float16 解码：建查找表比逐位算快得多 ---------- */
const HALF = new Float32Array(65536);
(function buildHalfTable() {
  const f32 = new Float32Array(1), i32 = new Int32Array(f32.buffer);
  for (let h = 0; h < 65536; h++) {
    const s = (h & 0x8000) >> 15, e = (h & 0x7C00) >> 10, f = h & 0x03FF;
    if (e === 0) { HALF[h] = (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024); }
    else if (e === 0x1F) { HALF[h] = f ? NaN : (s ? -1 : 1) * Infinity; }
    else { HALF[h] = (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024); }
  }
})();

/* ---------- 带进度、带缓存的下载 ---------- */
async function cachedFetch(url, onProgress) {
  let cache = null;
  try { cache = await caches.open('santi-rag-' + (MANIFEST ? MANIFEST.count + '-' + MANIFEST.dim : 'v1')); } catch (e) {}
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      if (onProgress) onProgress(1, 1, true);
      return await hit.arrayBuffer();
    }
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(url + ' → HTTP ' + resp.status);
  const total = Number(resp.headers.get('Content-Length')) || 0;
  let buf;
  if (onProgress && total && resp.body) {
    const reader = resp.body.getReader();
    const parts = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      onProgress(got, total, false);
    }
    buf = new Uint8Array(got);
    let off = 0;
    for (const p of parts) { buf.set(p, off); off += p.length; }
    buf = buf.buffer;
  } else {
    buf = await resp.arrayBuffer();
  }
  if (cache) { try { await cache.put(url, new Response(buf.slice(0))); } catch (e) {} }
  return buf;
}

async function loadLib() {
  const tried = [];
  let lastErr = null;
  // 先试自托管。
  // 注意：import() 的相对路径是【相对本模块】解析的，而 fetch() 是相对页面 ——
  // 用 DATA 拼会变成 /ragdata/ragdata/... 。用 import.meta.url 才两边都对，
  // 也能兼容 GitHub Pages 的 /santi-chat/ 子路径。
  try {
    const mod = await import(/* @vite-ignore */ DATA + 'lib/transformers.min.js');
    if (mod && mod.pipeline) return mod;
  } catch (e) { lastErr = e; tried.push('本站'); }
  // 兜底才走 CDN
  for (const base of CDNS) {
    try {
      const mod = await import(/* @vite-ignore */ base + '/dist/transformers.min.js');
      if (mod && mod.pipeline) return mod;
    } catch (e) { lastErr = e; tried.push(base.replace(/^https?:\/\//, '').split('/')[0]); }
  }
  throw new Error('无法加载推理库（试过：' + tried.join('、') + '）：' + (lastErr && lastErr.message));
}

/* ---------- 初始化 ---------- */
export async function init(onStage) {
  const say = (stage, text, loaded, total) => onStage && onStage({ stage, text, loaded, total });

  say('manifest', '读取清单');
  MANIFEST = await (await fetch(DATA + 'manifest.json', { cache: 'no-cache' })).json();
  say('lib', '加载推理库');

  const T = await loadLib();

  say('model', '下载切片（chunk）模型');
  // 模型只从本站拿（HF 主站国内打不开），所以关掉远程、打开本地
  T.env.allowRemoteModels = false;
  T.env.allowLocalModels = true;
  T.env.localModelPath = DATA + 'models/';
  T.env.useBrowserCache = true;
  /* ONNX Runtime 的 WASM 就放在 lib/ 里（跟 transformers.min.js 同目录）——
     ORT 默认就是去 bundle 所在目录找这两个文件，把文件放对位置
     比覆盖 wasmPaths 更省事，也实测覆盖不生效。
     这样一来，除了最后生成回答，整个页面不再请求任何外部域名。 */
  if (T.env.backends && T.env.backends.onnx && T.env.backends.onnx.wasm) {
    const w = T.env.backends.onnx.wasm;
    /* 必须显式设置：transformers.js 内部有一句
         wasmPaths || (wasmPaths = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@<ver>/dist/")
       也就是【不设就硬编码走 CDN】。传字符串前缀即可，文件就放在 lib/ 里。 */
    w.wasmPaths = DATA + 'lib/';
    // 关键：锁成单线程、不用 proxy worker。
    // 多线程模式下 ORT 会起 SharedArrayBuffer worker，
    // 在缺少跨源隔离头（COOP/COEP）的页面里会静默死锁 —— 表现为"会话创建永不返回"。
    w.numThreads = 1;
    w.proxy = false;
    w.simd = true;
  }
  extractor = await T.pipeline('feature-extraction', MODEL_ID, {
    dtype: 'q8',
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) say('model', '下载切片（chunk）模型', p.loaded, p.total);
    },
  });

  say('vectors', '下载语料向量', 0, MANIFEST.files['vectors.bin']);
  const vbuf = await cachedFetch(DATA + 'vectors.bin',
    (l, t) => say('vectors', '下载语料向量', l, t));
  const u16 = new Uint16Array(vbuf);
  const n = MANIFEST.count, d = MANIFEST.dim;
  V = new Float32Array(n * d);
  for (let i = 0; i < n * d; i++) V[i] = HALF[u16[i]];

  say('texts', '下载段落文本', 0, MANIFEST.files['chunks.json']);
  const cbuf = await cachedFetch(DATA + 'chunks.json',
    (l, t) => say('texts', '下载段落文本', l, t));
  RECS = JSON.parse(new TextDecoder('utf-8').decode(cbuf));

  const pbuf = await cachedFetch(DATA + 'personas.json');
  PERSONAS = JSON.parse(new TextDecoder('utf-8').decode(pbuf));

  say('ready', '就绪');
  return MANIFEST;
}

/* ---------- 嵌入 ---------- */
export async function embed(text) {
  const out = await extractor(text, { pooling: 'cls', normalize: true });
  return out.data;   // Float32Array(512)，已归一化
}

/* ---------- 检索 ---------- */
function topK(qv, filterFn, k) {
  const d = MANIFEST.dim, n = MANIFEST.count;
  const hits = [];
  for (let i = 0; i < n; i++) {
    if (filterFn && !filterFn(RECS[i])) continue;
    let dot = 0;
    const off = i * d;
    for (let j = 0; j < d; j++) dot += qv[j] * V[off + j];
    hits.push({ i, distance: 1 - dot });   // 归一化向量的余弦距离 = 1 - 点积
  }
  hits.sort((a, b) => a.distance - b.distance);
  return hits.slice(0, k);
}

export function searchVoices(character, qv, k = VOICE_K) {
  return topK(qv, (r) => r.ch === character, k).map((h) => ({
    quote: RECS[h.i].q || '',
    context: RECS[h.i].t || '',
    distance: h.distance,
  }));
}

export function searchPlot(qv, k = PLOT_K) {
  const base = topK(qv, (r) => r.k === 'base', k);
  // 相邻块扩展：命中块 index 已知，直接把同源相邻块捞出来
  const byKey = new Map();
  for (const r of RECS) if (r.k === 'base') byKey.set(r.s + '#' + r.c, r);
  // 先把所有命中登记进 seen，再扩展邻居 —— 与 Python 版一致，
  // 否则"某条命中正好是另一条的邻居"时会被重复加入
  const seen = new Set(base.map((h) => RECS[h.i].s + '#' + RECS[h.i].c));
  const out = [];
  for (const h of base) {
    const r = RECS[h.i];
    out.push({ content: r.t, chunk: r.c, distance: h.distance });
    for (let off = -NEIGHBOR_WINDOW; off <= NEIGHBOR_WINDOW; off++) {
      if (off === 0) continue;
      const key = r.s + '#' + (r.c + off);
      if (seen.has(key)) continue;
      const nb = byKey.get(key);
      if (nb) { seen.add(key); out.push({ content: nb.t, chunk: nb.c, distance: h.distance }); }
    }
  }
  return out;
}

export function personaOf(name) { return (PERSONAS && PERSONAS[name]) || {}; }

/* 从本地数据里给某个角色采样台词，用于生成角色卡。
   与 Python 版 _sample_quotes 同样的三段式：
     ① 时间跨度 —— 按出现顺序切段，每段取最长的一条
     ② 语气特征 —— 挑几条短而完整的（短句往往最有辨识度）
     ③ 信息量   —— 用最长的几条补足
   ids 是按全书顺序生成的，i 正好当位置用。 */
export function sampleQuotes(name, n = 14) {
  const idx = [];
  for (let i = 0; i < RECS.length; i++) if (RECS[i].k === 'voice' && RECS[i].ch === name) idx.push(i);
  const m = idx.length;
  if (m <= n) return idx.map((i) => RECS[i].q || RECS[i].t);
  const picked = new Set();
  const seg = Math.max(1, n >> 1);
  for (let k = 0; k < seg; k++) {
    const chunk = idx.slice((k * m / seg) | 0, ((k + 1) * m / seg) | 0);
    if (chunk.length) {
      picked.add(chunk.reduce((a, b) => ((RECS[b].q || '').length > (RECS[a].q || '').length ? b : a), chunk[0]));
    }
  }
  const shorts = idx.filter((i) => { const L = (RECS[i].q || '').length; return L >= 4 && L <= 18; })
                    .sort((a, b) => (RECS[b].q || '').length - (RECS[a].q || '').length);
  for (const i of shorts) { if (picked.size >= n - 2) break; picked.add(i); }
  for (const i of idx.slice().sort((a, b) => (RECS[b].q || '').length - (RECS[a].q || '').length)) {
    if (picked.size >= n) break;
    picked.add(i);
  }
  return idx.filter((i) => picked.has(i))
            .map((i) => {
              const ctx = (RECS[i].t || '').slice(0, 110).replace(/\n/g, ' ');
              return '情境：' + ctx + '\n台词：「' + (RECS[i].q || '').slice(0, 110) + '」';
            });
}
export function roster() { return MANIFEST ? MANIFEST.roster : {}; }
export function characters() { return MANIFEST ? Object.keys(MANIFEST.roster) : []; }
export function ready() { return !!(extractor && V && RECS && MANIFEST); }

/* ---------- 组装 prompt（与 Python 版逐字一致） ---------- */
const SYSTEM_TMPL = `你现在要扮演《三体》中的角色【{name}】（{title}）。

# 角色设定
{persona}

# 说话风格
{style}

# 时间线边界
{cutoff}

# 你在类似情境下说过的话（仅供感受语气，不要照搬）
{voices}

# 相关的剧情（如果你需要，可以自然地引用；不要复述、不要说"根据资料"）
{plot}

# 扮演规则
1. 始终以{name}的第一人称说话，直接回应，绝不能说自己是 AI、模型，或提到"扮演""设定""资料"。
2. 保持角色的性格、语气、价值观和知识边界 —— 你只知道上面【时间线边界】之内的事。
3. 不要编造原著里没有的剧情。拿不准时，用角色的口吻表达不确定或回避，而不是硬编。
4. 回答简短自然，像真人对话，通常 1～4 句话。不要长篇大论，不要分点列条。
5. 如果对方问的是与剧情无关的日常寒暄，就按角色性格正常闲聊。
`;

export function buildMessages(character, message, history, voices, plot) {
  const p = personaOf(character);
  const voiceText = voices.map((v, i) =>
    (i + 1) + '. 当时的情境：' + (v.context || '').slice(0, 150).replace(/\n/g, ' ') +
    '\n   你说：「' + (v.quote || '').slice(0, 100) + '」').join('\n') || '（无）';
  const plotText = plot.map((x) => '- ' + (x.content || '').slice(0, 200)).join('\n') || '（无）';
  const system = SYSTEM_TMPL
    .replace('{name}', character).replace('{title}', p.title || '')
    .replace('{persona}', p.persona || '').replace('{style}', p.style || '')
    .replace('{cutoff}', p.knowledge_cutoff || '')
    .replace('{voices}', voiceText).replace('{plot}', plotText);
  const msgs = [{ role: 'system', content: system }];
  for (const h of history.slice(-8)) msgs.push({ role: h.role, content: h.content });
  msgs.push({ role: 'user', content: message });
  return msgs;
}

/* ---------- 查询改写（解决代词指代） ---------- */
const REWRITE_PROMPT = `下面是一段对话记录，最后一行是用户最新说的话。

请把用户最新的话改写成一句**独立、完整、不含代词**的检索查询，用于在小说原文中检索相关内容。

要求：
- 把「他」「她」「它」「那个」「这件事」等代词替换成具体所指
- 保留用户真正想问的核心意思
- 只输出改写后的查询，不要解释，不要加引号
- 如果最新的话本身已经完整，原样输出即可

【对话记录】
{history}

用户最新说：{message}

改写后的查询：`;

export function rewritePrompt(history, message) {
  const h = history.slice(-8).map((x) =>
    (x.role === 'user' ? '用户' : '角色') + '：' + x.content.slice(0, 120)).join('\n');
  return REWRITE_PROMPT.replace('{history}', h).replace('{message}', message);
}
