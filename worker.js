/**
 * =================================================================================
 * 项目: nsfw-real-2api (Cloudflare Worker 单文件版)
 * 版本: 1.0.0 (代号: Chimera Synthesis - Gradio Pro)
 * 作者: 首席AI执行官 (Principal AI Executive Officer)
 * 日期: 2025-12-08
 * * [核心功能]
 * 1. [Gradio 协议桥接] 完美模拟 Gradio 的 Queue Join 和 SSE Data 流式通信。
 * 2. [参数全映射] 支持负向提示词、种子、步数、CFG Scale 等高级参数透传。
 * 3. [图片中转] 内置图片代理，解决 HF Space 临时链接的访问限制。
 * 4. [双模接口] 同时支持 Chat (文生图回显) 和 Image (标准DALL-E) 接口。
 * =================================================================================
 */

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  PROJECT_NAME: "nsfw-real-2api",
  PROJECT_VERSION: "1.0.0",
  
  // 安全配置 (建议在 Cloudflare 环境变量中设置 API_MASTER_KEY)
  API_MASTER_KEY: "1", 
  
  // 上游服务配置
  UPSTREAM_ORIGIN: "https://aiqtech-nsfw-real.hf.space",
  
  // 默认参数配置 (根据您提供的截图优化)
  DEFAULT_NEGATIVE_PROMPT: "nsfw, (low quality, worst quality:1.2), very displeasing, 3d, watermark, signature, ugly, poorly drawn",
  DEFAULT_WIDTH: 1024,
  DEFAULT_HEIGHT: 1024,
  DEFAULT_STEPS: 28,
  DEFAULT_GUIDANCE_SCALE: 7,
  
  // 模型列表
  MODELS: [
    "nsfw-real-v1",
    "stable-diffusion-xl"
  ],
  DEFAULT_MODEL: "nsfw-real-v1",
};

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    const url = new URL(request.url);

    // 1. CORS 预检
    if (request.method === 'OPTIONS') return handleCorsPreflight();

    // 2. 静态资源代理 (图片) - 关键：解决 HF 图片防盗链
    if (url.pathname.startsWith('/proxy/file/')) return handleImageProxy(request);

    // 3. 开发者驾驶舱 (Web UI)
    if (url.pathname === '/') return handleUI(request, apiKey);

    // 4. API 路由
    if (url.pathname.startsWith('/v1/')) return handleApi(request, apiKey);

    return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第三部分: 核心业务逻辑 (Gradio Protocol)] ---

class GradioClient {
  constructor(origin) {
    this.origin = origin;
    this.sessionHash = Math.random().toString(36).substring(2, 12);
  }

  async generateImage(params) {
    // 1. 构造 Gradio 请求载荷
    // 对应抓包中的 data 数组顺序: [prompt, negative_prompt, seed, randomize_seed, width, height, guidance_scale, steps]
    const payload = {
      data: [
        params.prompt,
        params.negative_prompt || CONFIG.DEFAULT_NEGATIVE_PROMPT,
        params.seed || 0,
        params.seed ? false : true, // 如果提供了 seed，则不随机
        params.width || CONFIG.DEFAULT_WIDTH,
        params.height || CONFIG.DEFAULT_HEIGHT,
        params.guidance_scale || CONFIG.DEFAULT_GUIDANCE_SCALE,
        params.steps || CONFIG.DEFAULT_STEPS
      ],
      event_data: null,
      fn_index: 0,
      trigger_id: 4,
      session_hash: this.sessionHash
    };

    // 2. 发送 Join 请求
    const joinRes = await fetch(`${this.origin}/gradio_api/queue/join?`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
      },
      body: JSON.stringify(payload)
    });

    if (!joinRes.ok) throw new Error(`Queue Join Failed: ${joinRes.status}`);

    // 3. 监听 SSE 数据流
    const dataUrl = `${this.origin}/gradio_api/queue/data?session_hash=${this.sessionHash}`;
    const dataRes = await fetch(dataUrl, {
      headers: { 
        "Accept": "text/event-stream",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
      }
    });

    if (!dataRes.ok) throw new Error(`Queue Data Failed: ${dataRes.status}`);

    // 4. 解析流并获取结果
    const reader = dataRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let resultUrl = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6).trim();
          try {
            const data = JSON.parse(jsonStr);
            
            // 处理完成消息
            if (data.msg === 'process_completed') {
              if (data.success && data.output && data.output.data && data.output.data[0]) {
                // 获取原始 URL
                const rawUrl = data.output.data[0].url;
                // 转换为代理 URL，以便客户端可以访问
                resultUrl = this.convertToProxyUrl(rawUrl);
              } else {
                throw new Error("生成成功但未找到图片数据");
              }
              return resultUrl; // 成功返回
            }
          } catch (e) {
            // 忽略非JSON行或解析错误
          }
        }
      }
    }
    
    throw new Error("流结束但未收到完成信号");
  }

  convertToProxyUrl(upstreamUrl) {
    // 上游 URL 格式: https://aiqtech-nsfw-real.hf.space/gradio_api/file=/tmp/...
    // 我们需要提取 /file= 后面的部分，并通过 Worker 代理
    if (upstreamUrl.includes('/file=')) {
        const filePath = upstreamUrl.split('/file=')[1];
        // 返回特殊标记，将在 handleApi 中替换为完整的 Worker 域名
        return `__PROXY_PREFIX__/proxy/file/${filePath}`;
    }
    return upstreamUrl;
  }
}

// --- [第四部分: API 接口处理] ---

async function handleApi(request, apiKey) {
  if (!verifyAuth(request, apiKey)) return createErrorResponse('Unauthorized', 401, 'unauthorized');

  const url = new URL(request.url);
  const workerOrigin = url.origin;

  // 模型列表接口
  if (url.pathname === '/v1/models') {
    return new Response(JSON.stringify({
      object: 'list',
      data: CONFIG.MODELS.map(id => ({ id, object: 'model', created: Date.now(), owned_by: 'nsfw-real' }))
    }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
  }

  const client = new GradioClient(CONFIG.UPSTREAM_ORIGIN);

  try {
    let body = {};
    try { body = await request.json(); } catch(e) {}
    
    // 参数提取与合并
    let params = {
      prompt: "",
      negative_prompt: CONFIG.DEFAULT_NEGATIVE_PROMPT,
      width: CONFIG.DEFAULT_WIDTH,
      height: CONFIG.DEFAULT_HEIGHT,
      steps: CONFIG.DEFAULT_STEPS,
      guidance_scale: CONFIG.DEFAULT_GUIDANCE_SCALE,
      seed: 0
    };

    // 1. 处理 Chat 接口 (Cherry Studio 等)
    if (url.pathname === '/v1/chat/completions') {
      const messages = body.messages || [];
      const lastMsg = messages[messages.length - 1];
      if (!lastMsg) throw new Error("No messages provided");
      
      // 尝试解析 JSON Prompt (高级用法)
      try {
        const jsonPrompt = JSON.parse(lastMsg.content);
        if (jsonPrompt.prompt) {
            params = { ...params, ...jsonPrompt };
        } else {
            params.prompt = lastMsg.content;
        }
      } catch (e) {
        params.prompt = lastMsg.content;
      }
    } 
    // 2. 处理 Image 接口 (标准 DALL-E)
    else if (url.pathname === '/v1/images/generations') {
      params.prompt = body.prompt;
      if (body.size) {
        const [w, h] = body.size.split('x').map(Number);
        if (w && h) { params.width = w; params.height = h; }
      }
      // 允许通过 extra_body 或直接字段传递高级参数
      if (body.negative_prompt) params.negative_prompt = body.negative_prompt;
      if (body.steps) params.steps = body.steps;
      if (body.guidance_scale) params.guidance_scale = body.guidance_scale;
    } else {
      return createErrorResponse('Not Found', 404, 'not_found');
    }

    if (!params.prompt) throw new Error("Prompt is required");

    // 执行生成
    let proxyUrl = await client.generateImage(params);
    // 替换代理前缀
    proxyUrl = proxyUrl.replace('__PROXY_PREFIX__', workerOrigin);

    // 构造响应
    if (url.pathname === '/v1/chat/completions') {
      const content = `![Generated Image](${proxyUrl})\n\n**Prompt:** ${params.prompt}`;
      // 模拟流式输出 (即时返回完整内容)
      if (body.stream) {
          const id = `chatcmpl-${Date.now()}`;
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
              start(controller) {
                  const chunk = {
                      id: id,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: body.model || CONFIG.DEFAULT_MODEL,
                      choices: [{ index: 0, delta: { content }, finish_reason: null }]
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  
                  const endChunk = {
                      id: id,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: body.model || CONFIG.DEFAULT_MODEL,
                      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
                  controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                  controller.close();
              }
          });
          return new Response(stream, { headers: corsHeaders({ 'Content-Type': 'text/event-stream' }) });
      }

      return new Response(JSON.stringify({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now()/1000),
        model: body.model || CONFIG.DEFAULT_MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
      }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
    } else {
      // Image Response
      return new Response(JSON.stringify({
        created: Math.floor(Date.now()/1000),
        data: [{ url: proxyUrl, revised_prompt: params.prompt }]
      }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
    }

  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

// 图片代理处理
async function handleImageProxy(request) {
  const url = new URL(request.url);
  // 路径格式: /proxy/file/tmp/gradio/...
  const filePath = url.pathname.replace('/proxy/file/', '');
  const upstreamUrl = `${CONFIG.UPSTREAM_ORIGIN}/gradio_api/file=${filePath}`;

  try {
    const res = await fetch(upstreamUrl, {
      headers: {
        "Referer": CONFIG.UPSTREAM_ORIGIN, // 欺骗上游防盗链
        "User-Agent": "Mozilla/5.0"
      }
    });
    
    const newHeaders = new Headers(res.headers);
    newHeaders.set('Access-Control-Allow-Origin', '*'); // 允许跨域
    
    return new Response(res.body, {
      status: res.status,
      headers: newHeaders
    });
  } catch (e) {
    return new Response("Image Proxy Failed", { status: 502 });
  }
}

// --- 辅助函数 ---
function verifyAuth(request, validKey) {
  if (validKey === "1") return true;
  const auth = request.headers.get('Authorization');
  return auth === `Bearer ${validKey}`;
}

function createErrorResponse(msg, status, code) {
  return new Response(JSON.stringify({ error: { message: msg, type: 'api_error', code } }), {
    status, headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

// --- [第五部分: 开发者驾驶舱 UI (WebUI)] ---
function handleUI(request, apiKey) {
  const origin = new URL(request.url).origin;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 驾驶舱</title>
    <style>
      :root { --bg: #0f172a; --panel: #1e293b; --text: #e2e8f0; --accent: #f472b6; --border: #334155; --input: #0f172a; }
      body { margin: 0; font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); height: 100vh; display: flex; overflow: hidden; }
      .sidebar { width: 340px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; }
      .main { flex: 1; display: flex; flex-direction: column; padding: 20px; position: relative; }
      
      h2 { margin: 0 0 20px 0; color: var(--accent); font-size: 18px; display: flex; align-items: center; gap: 10px; }
      .badge { font-size: 10px; background: var(--accent); color: #000; padding: 2px 6px; border-radius: 4px; }
      
      .group { margin-bottom: 15px; }
      .label { font-size: 12px; color: #94a3b8; margin-bottom: 5px; display: block; font-weight: 600; }
      input, textarea, select { width: 100%; background: var(--input); border: 1px solid var(--border); color: var(--text); padding: 8px; border-radius: 4px; box-sizing: border-box; font-family: monospace; }
      input:focus, textarea:focus { border-color: var(--accent); outline: none; }
      
      .slider-container { display: flex; align-items: center; gap: 10px; }
      input[type=range] { flex: 1; }
      .val-display { width: 40px; text-align: right; font-size: 12px; color: var(--accent); }

      button { width: 100%; background: var(--accent); color: #000; border: none; padding: 10px; border-radius: 4px; cursor: pointer; font-weight: bold; margin-top: 10px; transition: 0.2s; }
      button:hover { opacity: 0.9; }
      button:disabled { background: #475569; cursor: not-allowed; }

      .preview-area { flex: 1; background: #000; border: 1px solid var(--border); border-radius: 8px; display: flex; align-items: center; justify-content: center; overflow: hidden; position: relative; }
      .preview-area img { max-width: 100%; max-height: 100%; object-fit: contain; box-shadow: 0 0 20px rgba(0,0,0,0.5); }
      .placeholder { color: #475569; font-size: 14px; }
      
      .log-panel { height: 150px; background: #000; border-top: 1px solid var(--border); margin-top: 20px; padding: 10px; font-family: monospace; font-size: 11px; color: #94a3b8; overflow-y: auto; }
      .log-entry { margin-bottom: 4px; border-bottom: 1px solid #1e293b; padding-bottom: 2px; }
      .log-time { color: #64748b; margin-right: 8px; }
      
      .code-block { background: #111; padding: 8px; border-radius: 4px; font-size: 11px; color: var(--accent); cursor: pointer; word-break: break-all; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2>NSFW-Real 2API <span class="badge">v${CONFIG.PROJECT_VERSION}</span></h2>
        
        <div class="group">
            <span class="label">API Key</span>
            <input type="password" id="apiKey" value="${apiKey}">
        </div>
        
        <div class="group">
            <span class="label">API Endpoint (点击复制)</span>
            <div class="code-block" onclick="copy('${origin}/v1/images/generations')">${origin}/v1/images/generations</div>
        </div>

        <div class="group">
            <span class="label">提示词 (Prompt)</span>
            <textarea id="prompt" rows="4" placeholder="a beautiful girl...">a masterpiece, 8k, realistic photo of a cyberpunk city street</textarea>
        </div>

        <div class="group">
            <span class="label">负向提示词 (Negative Prompt)</span>
            <textarea id="neg_prompt" rows="3">${CONFIG.DEFAULT_NEGATIVE_PROMPT}</textarea>
        </div>

        <div class="group">
            <div class="slider-container">
                <span class="label">宽度</span>
                <input type="range" id="width" min="256" max="2048" step="64" value="${CONFIG.DEFAULT_WIDTH}" oninput="updateVal('width', this.value)">
                <span id="val-width" class="val-display">${CONFIG.DEFAULT_WIDTH}</span>
            </div>
        </div>

        <div class="group">
            <div class="slider-container">
                <span class="label">高度</span>
                <input type="range" id="height" min="256" max="2048" step="64" value="${CONFIG.DEFAULT_HEIGHT}" oninput="updateVal('height', this.value)">
                <span id="val-height" class="val-display">${CONFIG.DEFAULT_HEIGHT}</span>
            </div>
        </div>

        <div class="group">
            <div class="slider-container">
                <span class="label">步数</span>
                <input type="range" id="steps" min="10" max="50" step="1" value="${CONFIG.DEFAULT_STEPS}" oninput="updateVal('steps', this.value)">
                <span id="val-steps" class="val-display">${CONFIG.DEFAULT_STEPS}</span>
            </div>
        </div>

        <button id="genBtn" onclick="generate()">🚀 开始生成</button>
    </div>

    <div class="main">
        <div class="preview-area" id="preview">
            <div class="placeholder">等待生成指令...</div>
        </div>
        <div class="log-panel" id="logs">
            <div class="log-entry">系统就绪。</div>
        </div>
    </div>

    <script>
        function updateVal(id, val) { document.getElementById('val-'+id).innerText = val; }
        function log(msg) {
            const el = document.getElementById('logs');
            const div = document.createElement('div');
            div.className = 'log-entry';
            div.innerHTML = \`<span class="log-time">[\${new Date().toLocaleTimeString()}]</span> \${msg}\`;
            el.appendChild(div);
            el.scrollTop = el.scrollHeight;
        }
        function copy(text) { navigator.clipboard.writeText(text); log("地址已复制"); }

        async function generate() {
            const btn = document.getElementById('genBtn');
            const preview = document.getElementById('preview');
            const apiKey = document.getElementById('apiKey').value;
            
            btn.disabled = true;
            btn.innerText = "生成中 (约10-30秒)...";
            preview.innerHTML = '<div class="placeholder">⏳ 正在请求 GPU 资源...</div>';
            
            const payload = {
                prompt: document.getElementById('prompt').value,
                negative_prompt: document.getElementById('neg_prompt').value,
                width: parseInt(document.getElementById('width').value),
                height: parseInt(document.getElementById('height').value),
                steps: parseInt(document.getElementById('steps').value),
                guidance_scale: 7,
                seed: 0
            };

            log("发送生成请求...");

            try {
                const res = await fetch('/v1/images/generations', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + apiKey
                    },
                    body: JSON.stringify(payload)
                });

                if (!res.ok) throw new Error(await res.text());

                const data = await res.json();
                const imgUrl = data.data[0].url;
                
                log("生成成功! 加载图片...");
                preview.innerHTML = \`<img src="\${imgUrl}" onclick="window.open(this.src)">\`;
                
            } catch (e) {
                log("错误: " + e.message);
                preview.innerHTML = \`<div class="placeholder" style="color:#f87171">❌ 生成失败: \${e.message}</div>\`;
            } finally {
                btn.disabled = false;
                btn.innerText = "🚀 开始生成";
            }
        }
    </script>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
