import { json, CORS, readState, writeState, MSG_LIMIT, callDeepSeek } from './_lib.js';

/* 瘦代理：前端已经在本机做完检索、自己组装好 messages，
   这里只负责带上 API key 转发，并按访客计额度。

   所以后端不需要向量库、不需要嵌入模型 —— 部署体积从 225MB 降到几十 KB。 */

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ code: 'bad_request', message: '请求体不是合法 JSON' }, 400); }

  const messages = body.messages || [];
  if (!messages.length) return json({ code: 'bad_request', message: 'messages 不能为空' }, 400);

  const client = String(body.client || 'anon').slice(0, 64);
  const purpose = String(body.purpose || 'chat');
  const character = String(body.character || '');

  // 只有「生成回答」计入对话额度，查询改写不单独计数
  if (purpose === 'chat') {
    const st = await readState(env, client);
    if (!st.unlimited) {
      const used = Number(st.msgs[character] || 0);
      if (used >= MSG_LIMIT) {
        return json({
          code: 'msg_limit', character, used, limit: MSG_LIMIT,
          message: '与「' + character + '」的对话已达上限（' + MSG_LIMIT + ' 条）',
        }, 403);
      }
      st.msgs[character] = used + 1;
      await writeState(env, client, st);
    }
  }

  let upstream;
  try {
    upstream = await callDeepSeek(env, {
      messages,
      temperature: body.temperature === undefined ? 0.8 : Number(body.temperature),
      max_tokens: Number(body.max_tokens || 800),
      stream: true,
    });
  } catch (e) {
    return json({ code: 'llm_error', message: String(e) }, 502);
  }
  if (!upstream.ok) {
    const t = await upstream.text();
    return json({ code: 'llm_error', message: 'DeepSeek ' + upstream.status + ': ' + t.slice(0, 300) }, 502);
  }

  // DeepSeek 返回的就是标准 OpenAI SSE，直接透传，前端自己解析
  return new Response(upstream.body, {
    headers: {
      ...CORS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}
