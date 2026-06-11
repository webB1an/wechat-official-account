import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = resolve(__dirname, '..');
const editorDir = join(rootDir, 'huasheng_editor');
const dataDir = join(rootDir, 'data');

async function loadDotEnv() {
  const envPath = join(rootDir, '.env');
  if (!existsSync(envPath)) return;

  const content = await readFile(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (!key || process.env[key]) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

await loadDotEnv();

const port = Number(process.env.PORT || 8787);
const forceMockGeneration = String(process.env.MOCK_DEEPSEEK || '').toLowerCase() === 'true';
const deepseekApiKey = forceMockGeneration ? '' : (process.env.DEEPSEEK_API_KEY || '');
const verboseLogs = String(process.env.VERBOSE_LOGS || 'true').toLowerCase() !== 'false';
const sitePassword = String(process.env.SITE_PASSWORD || '');
const authCookieName = 'wechat_editor_auth';
const authCookieValue = sitePassword
  ? createHash('sha256').update(`wechat-editor-auth:${sitePassword}`).digest('hex')
  : '';

if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

const db = new DatabaseSync(join(dataDir, 'pushed_books.sqlite'));
db.exec(`
  CREATE TABLE IF NOT EXISTS pushed_books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_title TEXT NOT NULL,
    normalized_title TEXT NOT NULL UNIQUE,
    copied_at TEXT NOT NULL
  );
`);

function normalizeBookTitle(title) {
  return String(title || '')
    .normalize('NFKC')
    .replace(/[《》<>「」『』“”"']/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function htmlResponse(res, status, html, headers = {}) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    ...headers
  });
  res.end(body);
}

function parseCookies(cookieHeader = '') {
  const cookies = {};
  for (const pair of cookieHeader.split(';')) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function isAuthenticated(req) {
  if (!sitePassword) return true;
  const cookies = parseCookies(req.headers.cookie || '');
  return constantTimeEqual(cookies[authCookieName] || '', authCookieValue);
}

function authCookieHeader(maxAge = 60 * 60 * 24 * 7) {
  return [
    `${authCookieName}=${encodeURIComponent(authCookieValue)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ].join('; ');
}

function redirectResponse(res, location, headers = {}) {
  res.writeHead(303, {
    Location: location,
    ...headers
  });
  res.end();
}

function serveLoginPage(res, hasError = false) {
  htmlResponse(res, 200, `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>访问验证</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #f6f7f9;
      color: #111;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    }
    main {
      width: min(92vw, 360px);
      padding: 28px;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      box-shadow: 0 18px 40px rgba(15, 23, 42, 0.08);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 22px;
      line-height: 1.25;
      letter-spacing: 0;
    }
    p {
      margin: 0 0 22px;
      color: #5f6673;
      font-size: 14px;
      line-height: 1.7;
    }
    label {
      display: block;
      margin-bottom: 8px;
      color: #303642;
      font-size: 14px;
      font-weight: 600;
    }
    input {
      width: 100%;
      height: 44px;
      padding: 0 12px;
      border: 1px solid #cfd5df;
      border-radius: 6px;
      font-size: 16px;
      outline: none;
    }
    input:focus {
      border-color: #2563eb;
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14);
    }
    button {
      width: 100%;
      height: 44px;
      margin-top: 16px;
      border: 0;
      border-radius: 6px;
      background: #111827;
      color: #fff;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
    }
    .error {
      margin: 12px 0 0;
      color: #b42318;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <main>
    <h1>访问验证</h1>
    <p>请输入站点密码后继续使用公众号排版器。</p>
    <form method="post" action="/api/auth/login">
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
      <button type="submit">进入</button>
      ${hasError ? '<div class="error">密码不正确，请重试。</div>' : ''}
    </form>
  </main>
</body>
</html>`);
}

function createRequestLogger(scope = 'app') {
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  return {
    requestId,
    info(message, meta = {}) {
      writeLog('info', scope, requestId, startedAt, message, meta);
    },
    warn(message, meta = {}) {
      writeLog('warn', scope, requestId, startedAt, message, meta);
    },
    error(message, meta = {}) {
      writeLog('error', scope, requestId, startedAt, message, meta);
    }
  };
}

function writeLog(level, scope, requestId, startedAt, message, meta = {}) {
  if (!verboseLogs && level === 'info') return;
  const elapsedMs = Date.now() - startedAt;
  const safeMeta = redactLogMeta(meta);
  const line = {
    ts: new Date().toISOString(),
    level,
    scope,
    requestId,
    elapsedMs,
    message,
    ...safeMeta
  };
  const output = JSON.stringify(line);
  if (level === 'error') {
    console.error(output);
  } else if (level === 'warn') {
    console.warn(output);
  } else {
    console.log(output);
  }
}

function redactLogMeta(value) {
  if (value === null || value === undefined) return {};
  if (Array.isArray(value)) return value.map((item) => redactLogMeta(item));
  if (typeof value !== 'object') return value;

  const result = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (/^(apiKey|secret|password|authorization)$/i.test(key) || /(_key|token)$/i.test(key)) {
      result[key] = '[redacted]';
    } else if (typeof rawValue === 'string') {
      result[key] = rawValue.length > 320 ? `${rawValue.slice(0, 320)}...` : rawValue;
    } else if (rawValue && typeof rawValue === 'object') {
      result[key] = redactLogMeta(rawValue);
    } else {
      result[key] = rawValue;
    }
  }
  return result;
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function readRequestJson(req) {
  const raw = await readRequestBody(req);
  return raw ? JSON.parse(raw) : {};
}

async function handleAuthLogin(req, res) {
  if (!sitePassword) {
    redirectResponse(res, '/');
    return;
  }

  const raw = await readRequestBody(req);
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  let password = '';

  if (contentType.includes('application/json')) {
    try {
      password = String(JSON.parse(raw || '{}').password || '');
    } catch {
      password = '';
    }
  } else {
    password = String(new URLSearchParams(raw).get('password') || '');
  }

  if (constantTimeEqual(password, sitePassword)) {
    redirectResponse(res, '/', {
      'Set-Cookie': authCookieHeader()
    });
    return;
  }

  redirectResponse(res, '/login?error=1');
}

function handleAuthLogout(res) {
  redirectResponse(res, '/login', {
    'Set-Cookie': authCookieHeader(0)
  });
}

function requireAuth(req, res, url) {
  if (isAuthenticated(req)) return true;

  if (url.pathname.startsWith('/api/')) {
    jsonResponse(res, 401, { error: 'AUTH_REQUIRED' });
    return false;
  }

  redirectResponse(res, '/login');
  return false;
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${port}`);
  const pathname = decodeURIComponent(url.pathname);
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(editorDir, requestedPath));

  if (!filePath.startsWith(editorDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function recommendBooksTool() {
  return {
    type: 'function',
    function: {
      name: 'recommend_books',
      description: '推荐适合微信公众号推书栏目创作的真实书籍候选。',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['theme', 'candidates'],
        properties: {
          theme: { type: 'string' },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'author', 'category', 'reason', 'readerFit'],
              properties: {
                title: { type: 'string' },
                author: { type: 'string' },
                category: { type: 'string' },
                reason: { type: 'string' },
                readerFit: { type: 'string' }
              }
            }
          }
        }
      }
    }
  };
}

function readerNoteTool() {
  return {
    type: 'function',
    function: {
      name: 'capture_reader_note',
      description: '捕捉读者读完书后最原始、未整理的感受备忘录。句子可以不完整，允许前后矛盾。',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['rawFeeling', 'readingMoment', 'oneSceneRemembered', 'personalQuestion'],
        properties: {
          rawFeeling: { type: 'string' },
          readingMoment: { type: 'string' },
          oneSceneRemembered: { type: 'string' },
          personalQuestion: { type: 'string' }
        }
      }
    }
  };
}

function createArticleTool() {
  const textArray = { type: 'array', items: { type: 'string' } };

  return {
    type: 'function',
    function: {
      name: 'create_wechat_book_article',
      description: '围绕一本书生成微信公众号推书文章包和视觉 brief。',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: [
          'book',
          'titles',
          'abstract',
          'article',
          'visual',
          'momentsCopy',
          'interactionPrompts',
          'tags'
        ],
        properties: {
          book: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'author', 'category', 'oneSentenceReason', 'bookValueSummary'],
            properties: {
              title: { type: 'string' },
              author: { type: 'string' },
              category: { type: 'string' },
              oneSentenceReason: { type: 'string' },
              bookValueSummary: { type: 'string' }
            }
          },
          titles: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'title'],
              properties: {
                type: { type: 'string' },
                title: { type: 'string' }
              }
            }
          },
          abstract: {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'keywords'],
            properties: {
              text: { type: 'string' },
              keywords: textArray
            }
          },
          article: {
            type: 'object',
            additionalProperties: false,
            required: ['structureName', 'closingCallToAction', 'sections'],
            properties: {
              structureName: { type: 'string' },
              closingCallToAction: { type: 'string' },
              sections: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['sectionType', 'title', 'paragraphs', 'items'],
                  properties: {
                    sectionType: {
                      type: 'string',
                      enum: [
                        'opening',
                        'story',
                        'phenomenon',
                        'question',
                        'analysis',
                        'book_intro',
                        'book_value',
                        'insight',
                        'application',
                        'quote_summary',
                        'suitable_readers',
                        'reading_suggestion',
                        'ending'
                      ]
                    },
                    title: { type: 'string' },
                    paragraphs: textArray,
                    items: textArray
                  }
                }
              }
            }
          },
          visual: {
            type: 'object',
            additionalProperties: false,
            required: ['cover', 'inlineImages'],
            properties: {
              cover: {
                type: 'object',
                additionalProperties: false,
                required: ['headline', 'subtitle', 'mood', 'palette', 'symbol'],
                properties: {
                  headline: { type: 'string' },
                  subtitle: { type: 'string' },
                  mood: { type: 'string' },
                  palette: textArray,
                  symbol: { type: 'string' }
                }
              },
              inlineImages: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['title', 'subtitle', 'caption', 'mood', 'palette', 'symbol'],
                  properties: {
                    title: { type: 'string' },
                    subtitle: { type: 'string' },
                    caption: { type: 'string' },
                    mood: { type: 'string' },
                    palette: textArray,
                    symbol: { type: 'string' }
                  }
                }
              }
            }
          },
          momentsCopy: textArray,
          interactionPrompts: textArray,
          tags: textArray
        }
      }
    }
  };
}

function parseToolArguments(args, toolName) {
  if (typeof args !== 'string') {
    return args;
  }

  try {
    return JSON.parse(args);
  } catch (error) {
    const extracted = extractFirstJsonObject(args);
    if (extracted) {
      try {
        return JSON.parse(extracted);
      } catch {
        // Fall through to the clearer error below.
      }
    }

    const positionMatch = /position\s+(\d+)/i.exec(error.message);
    const position = positionMatch ? Number(positionMatch[1]) : -1;
    const start = position >= 0 ? Math.max(0, position - 180) : 0;
    const end = position >= 0 ? Math.min(args.length, position + 180) : Math.min(args.length, 360);
    const excerpt = args.slice(start, end);
    throw new Error(`Failed to parse ${toolName} arguments: ${error.message}. Excerpt: ${excerpt}`);
  }
}

function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return '';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index++) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return '';
}

function sanitizeReaderNote(readerNote) {
  return {
    rawFeeling: sanitizeModelText(readerNote?.rawFeeling),
    readingMoment: sanitizeModelText(readerNote?.readingMoment),
    oneSceneRemembered: sanitizeModelText(readerNote?.oneSceneRemembered),
    personalQuestion: sanitizeModelText(readerNote?.personalQuestion)
  };
}

function sanitizeModelText(value) {
  return String(value || '')
    .replace(/["]/g, '”')
    .replace(/[\\]/g, '、')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeArticlePackage(articlePackage, readerNote) {
  if (!articlePackage || typeof articlePackage !== 'object') {
    return articlePackage;
  }

  const result = articlePackage;
  result.readerNote = readerNote;

  if (typeof result.book === 'string') {
    try {
      result.book = JSON.parse(result.book);
    } catch {
      // Leave validation to report the shape problem.
    }
  }

  if (Array.isArray(result.tags)) {
    result.tags = result.tags
      .map((tag) => String(tag || '').replace(/^#+/, '').trim())
      .filter(Boolean);
  }

  return result;
}

async function callDeepSeekTool({ tool, toolName, messages, temperature = 0.9, maxTokens = 4096, logger = null }) {
  const startedAt = Date.now();
  logger?.info('deepseek tool call start', { toolName, temperature, maxTokens });
  const response = await fetch('https://api.deepseek.com/beta/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${deepseekApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      temperature,
      max_tokens: maxTokens,
      tools: [tool],
      tool_choice: {
        type: 'function',
        function: { name: toolName }
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    logger?.error('deepseek tool call failed', {
      toolName,
      status: response.status,
      durationMs: Date.now() - startedAt,
      body: text
    });
    throw new Error(`DeepSeek API failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  const args = toolCall?.function?.arguments;
  if (!args) {
    logger?.error('deepseek tool call missing arguments', {
      toolName,
      durationMs: Date.now() - startedAt,
      finishReason: data.choices?.[0]?.finish_reason || ''
    });
    throw new Error('DeepSeek did not return tool call arguments');
  }

  try {
    const parsed = parseToolArguments(args, toolName);
    logger?.info('deepseek tool call parsed', {
      toolName,
      durationMs: Date.now() - startedAt,
      rawArgumentLength: typeof args === 'string' ? args.length : 0
    });
    return parsed;
  } catch (error) {
    logger?.error('deepseek tool arguments parse failed', {
      toolName,
      durationMs: Date.now() - startedAt,
      message: error.message
    });
    throw error;
  }
}

async function callDeepSeekChat({ messages, temperature = 0.75, maxTokens = 1200, logger = null }) {
  const startedAt = Date.now();
  logger?.info('deepseek chat call start', { temperature, maxTokens });
  const response = await fetch('https://api.deepseek.com/beta/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${deepseekApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      temperature,
      max_tokens: maxTokens
    })
  });

  if (!response.ok) {
    logger?.warn('deepseek chat call failed', {
      status: response.status,
      durationMs: Date.now() - startedAt
    });
    return null;
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || null;
  logger?.info('deepseek chat call completed', {
    durationMs: Date.now() - startedAt,
    contentLength: content ? content.length : 0
  });
  return content;
}

function randomTheme() {
  const themes = [
    '个人成长',
    '心理疗愈',
    '情绪管理',
    '职场提升',
    '认知思维',
    '亲密关系',
    '亲子教育',
    '人生哲学',
    '历史人物',
    '商业财经',
    '女性成长',
    '文学小说',
    '社会观察',
    '自我管理',
    '普通人改变命运'
  ];
  return themes[Math.floor(Math.random() * themes.length)];
}

function mockCandidates(theme) {
  return {
    theme,
    candidates: [
      { title: '被讨厌的勇气', author: '岸见一郎、古贺史健', category: '心理成长', reason: '用对话方式讨论普通人如何从他人的评价里松开一点。', readerFit: '适合容易内耗、在关系里紧绷的读者。' },
      { title: '也许你该找个人聊聊', author: '洛莉·戈特利布', category: '心理疗愈', reason: '把咨询室里的故事写得具体而有人味。', readerFit: '适合想理解自己情绪但不想被说教的人。' },
      { title: '悉达多', author: '赫尔曼·黑塞', category: '文学小说', reason: '用很短的篇幅写一个人如何寻找自己的生活答案。', readerFit: '适合在人生阶段转换时阅读。' },
      { title: '纳瓦尔宝典', author: '埃里克·乔根森', category: '商业认知', reason: '把财富、判断力和长期主义讲得很克制。', readerFit: '适合希望重新理解工作与时间的人。' },
      { title: '蛤蟆先生去看心理医生', author: '罗伯特·戴博德', category: '心理疗愈', reason: '借故事把心理咨询中的自我理解讲得轻。', readerFit: '适合想读得轻松但有所收获的人。' },
      { title: '置身事内', author: '兰小欢', category: '社会财经', reason: '帮助普通人理解身边经济现象背后的运行逻辑。', readerFit: '适合对社会运行和个人选择感兴趣的读者。' },
      { title: '长安的荔枝', author: '马伯庸', category: '历史小说', reason: '把职场压力放进历史故事里，读起来轻快也有余味。', readerFit: '适合想读故事又想看现实照影的人。' },
      { title: '刻意练习', author: '安德斯·艾利克森、罗伯特·普尔', category: '能力提升', reason: '把能力形成讲得比天赋叙事更具体。', readerFit: '适合想改善学习和工作方法的人。' }
    ]
  };
}

function mockReaderNote(book) {
  return {
    rawFeeling: `读完《${book.title}》以后，有点不知道说什么。不是没感受，是感受太散了，一时理不清楚。`,
    readingMoment: '周日下午，喝了很多茶，读得比较慢，一直停下来发呆。',
    oneSceneRemembered: '有段描写一直留着，不是因为写得漂亮，是因为我突然觉得那个人的处境我好像认识。',
    personalQuestion: '我在想，一个人明明知道哪里不对，但还是继续，这算自欺还是算将就？'
  };
}

function mockArticle(book, theme, readerNote) {
  return {
    book: {
      title: book.title,
      author: book.author,
      category: book.category,
      oneSentenceReason: book.reason,
      bookValueSummary: '它不急着给结论，而是把人心里那点不好开口的犹豫，慢慢摊开给你看。'
    },
    readerNote,
    titles: [
      { type: '情绪共鸣型', title: `有些累，不是睡一觉就能好的` },
      { type: '痛点解决型', title: `最近有点撑不住时，我会想起《${book.title}》` },
      { type: '高级文艺型', title: `人慢下来以后，才听见自己` },
      { type: '反常识型', title: `不急着变好，也许也是一种开始` },
      { type: '收藏转发型', title: `这本书适合在安静的时候读几页` },
      { type: '朋友聊天型', title: `想把《${book.title}》推荐给最近不太说话的你` }
    ],
    abstract: {
      text: `有些书不是用来立刻解决问题的。它只是陪你坐一会儿，把那些说不出口的疲惫、犹豫和不甘，慢慢放到光下面。《${book.title}》适合在安静的时候读，不催你变好，只让你先看见自己。`,
      keywords: [theme, book.category, '公众号推书']
    },
    article: {
      structureName: '生活观察型',
      closingCallToAction: `如果你也读过《${book.title}》，我想知道，哪一处让你停了下来。`,
      sections: [
        { sectionType: 'opening', title: '', paragraphs: ['有些书读完以后，不会马上让人想说点什么。', `我合上《${book.title}》时，反而有点空。不是被某句话击中，也不是突然想通了什么，就是觉得心里有个地方被轻轻碰了一下，过了很久还在。`], items: [] },
        { sectionType: 'story', title: '我记住的是那些没说出口的地方', paragraphs: [`《${book.title}》里最打动我的，不是情节有多大，也不是人物经历了多少转折，而是那些停顿。`, '有些委屈没有被摊开讲，有些难过只是从一句很平常的话里漏出来。读到那里，人会下意识慢下来。'], items: [] },
        { sectionType: 'book_value', title: '', paragraphs: [`我不太想把《${book.title}》说成一本“能解决什么问题”的书。它更像是一段很安静的陪伴。`, '它没有急着把人推向更好的自己，也没有把难过包装得很漂亮。它只是让你看见：人有时候就是会卡住，会嘴上说没事，心里却很久都过不去。'], items: [] },
        { sectionType: 'insight', title: '', paragraphs: ['读这本书时，我一直想到一件很小的事：人有时并不是靠一个答案撑下来的。', '可能只是因为饭还没吃，灯还没关，明天还有一件不算重要但必须去做的事。那些不起眼的动作，把人一点点留在生活里。'], items: [] },
        { sectionType: 'ending', title: '', paragraphs: [`我喜欢《${book.title}》的一点，是它没有把人写得很漂亮。`, '人会脆弱，会犯错，会在很长一段时间里没有答案。但日子还是一天天往前走。写到这里，我也不想再多说什么了。'], items: [] }
      ]
    },
    visual: {
      cover: { headline: `读《${book.title}》`, subtitle: '给最近有点累的你', mood: '克制、安静、带一点光', palette: ['#17202A', '#F6F1E8', '#C8A96A', '#6B8F8A'], symbol: '一本打开的书与一束斜光' },
      inlineImages: [
        { title: '不是所有疲惫都需要答案', subtitle: '先承认它存在', caption: '读书有时是一种慢慢恢复的方式', mood: '温柔克制', palette: ['#25313B', '#F4EFE7', '#D7B56D'], symbol: '纸页、光线、圆点' },
        { title: '把自己看清一点', subtitle: '比立刻改变更重要', caption: '好的阅读会让复杂的感受有地方安放', mood: '理性安静', palette: ['#2F3A35', '#F5F2EA', '#8FA99B'], symbol: '路径、注释、书签' },
        { title: '慢一点，也没有关系', subtitle: '阅读不是赶路', caption: '给自己几页纸的时间', mood: '陪伴感', palette: ['#1E2430', '#F7F0E2', '#BFA46A'], symbol: '月光、书桌、留白' }
      ]
    },
    momentsCopy: ['这本书适合在有点安静不下来的晚上读。', '它不急着安慰你，只是陪你把一些感受看清楚。'],
    interactionPrompts: [`如果你也读过《${book.title}》，哪一幕最久地留在了你心里？`, '你最近有没有一本书，是读完以后不太想马上说话的？'],
    tags: [theme, '读书', '自我理解', '公众号推书']
  };
}

async function recommendCandidates(theme, logger = null) {
  if (!deepseekApiKey) {
    logger?.info('using mock candidates', { theme });
    return mockCandidates(theme);
  }

  return callDeepSeekTool({
    tool: recommendBooksTool(),
    toolName: 'recommend_books',
    maxTokens: 2048,
    logger,
    messages: [
      {
        role: 'system',
        content: '你是一名克制、可靠的公众号读书内容策划。只推荐真实存在的书，不推荐过于学术、过冷门或传播性很弱的书。'
      },
      {
        role: 'user',
        content: `请围绕主题「${theme}」推荐 8 本候选书。要求书名和作者尽量准确，理由具体，不要鸡血，不要营销腔。`
      }
    ]
  });
}

async function generateReaderNote(book, theme, logger = null) {
  if (!deepseekApiKey) {
    logger?.info('using mock reader note', { bookTitle: book.title });
    return mockReaderNote(book);
  }

  return callDeepSeekTool({
    tool: readerNoteTool(),
    toolName: 'capture_reader_note',
    temperature: 1.1,
    maxTokens: 600,
    logger,
    messages: [
      {
        role: 'system',
        content: [
          '你刚读完一本书，在手机备忘录里随手写感受。',
          '不要写成文章，不要有结论，不要总结这本书的价值。',
          '句子可以写一半，可以前后矛盾，可以有很私人的联想。',
          '就是脑子里乱七八糟转着的东西，没整理过的那种。'
        ].join('\n')
      },
      {
        role: 'user',
        content: `书名：《${book.title}》\n作者：${book.author}\n主题方向：${theme}\n\n你刚读完，写下最直接的感受，不要整理。`
      }
    ]
  });
}

async function createArticle(book, theme, readerNote, logger = null, retryFeedback = []) {
  if (!deepseekApiKey) {
    logger?.info('using mock article', { bookTitle: book.title });
    return mockArticle(book, theme, readerNote);
  }

  const retryInstructions = retryFeedback.length > 0
    ? [
        '',
        '上一次生成失败，必须修正这些问题：',
        ...retryFeedback.map((error) => `- ${error}`),
        '如果失败原因包含 JSON parse / Expected "," / Expected "]"，说明你在工具参数字符串里写了未转义的半角英文双引号。',
        '正文、标题、caption 里不要使用半角英文双引号 "。需要强调词语时，改用中文冒号、顿号、书名号或单引号。',
        '如果失败原因包含 list-like plot summary detected，说明你写成了条目清单或短句堆叠。改成自然段，不要罗列观点，不要输出 4 条以上短句。'
      ]
    : [];

  return callDeepSeekTool({
    tool: createArticleTool(),
    toolName: 'create_wechat_book_article',
    maxTokens: 5500,
    temperature: 0.85,
    logger,
    messages: [
      {
        role: 'system',
        content: [
          '你是一名公众号读书栏目作者，先是真实读者，再是写作者。',
          '你已经写好了读书备忘录（见下方）。现在把它扩展成公众号正文。',
          '要求：文章的克制程度不能低于备忘录。不能比备忘录更整齐、更有结论感。',
          '读书备忘录只作为写作参考，不要在工具输出中返回 readerNote 字段。',
          '',
          '禁止：',
          '- 伪造书中原文金句或具体对话',
          '- 编造无法核验的场景、制度条文、精确细节',
          '- 使用这些词：核心洞察、值得每个人读、重新理解、重新校准、底层逻辑、坐标、',
          '  真正的、其实、很多时候、我们总是、你会发现、这本书告诉我们、在这个时代、',
          '  人间值得、全部的意义、折射出、某种程度上、不妨、也许正是、恰恰是、本质上、',
          '  让我们、评论区等你',
          '- 把每段结尾都写成升华句或总结句',
          '- 超过 2 个 section 标题',
          '- 在正文中完整复述剧情或罗列观点清单',
          '- 正文、标题、图片文案里使用半角英文双引号 "。需要引用词语时改用中文书名号、中文冒号或单引号',
          '',
          '正文约 900 到 1100 字。不要为了凑字数而写。',
          '涉及书中内容，一律用概括表达，不写无法核验的具体细节。',
          '输出必须走工具调用。'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          `主题：${theme}`,
          `书名：${book.title}`,
          `作者：${book.author}`,
          `类型：${book.category}`,
          '',
          '你的读书备忘录（只作为写作参考，不要输出 readerNote 字段）：',
          `rawFeeling: ${readerNote.rawFeeling}`,
          `readingMoment: ${readerNote.readingMoment}`,
          `oneSceneRemembered: ${readerNote.oneSceneRemembered}`,
          `personalQuestion: ${readerNote.personalQuestion}`,
          '',
          '生成要求：',
          '- 标题 6 个，风格要有差异',
          '- 摘要 80 到 100 字',
          '- sections 5 到 6 个，opening、book_value、ending 必须出现',
          '- 多数 section title 留空字符串，最多写 2 个',
          '- closingCallToAction 一句自然的互动，不要运营腔',
          '- 文内图 brief 3 张',
          '- 封面只展示 visual.cover.headline 一个主标题，不展示分类和副标题',
          '- visual.cover.headline 必须是 6 到 12 个汉字的短标题，最多 14 个汉字，不要写完整长句，不要出现逗号',
          '- visual.cover.subtitle 仍需填写，但只作为备用信息，不要承载关键信息',
          '- 朋友圈文案 2 条，互动引导 2 条（自然短句），标签 4 个',
          '- tags 必须是字符串数组，标签只写纯文字，不要带 # 号',
          '- visual brief 用于 HTML/CSS 生成图片，不要要求真实书封、作者照片或出版社图',
          ...retryInstructions
        ].join('\n')
      }
    ]
  });
}

const AI_SENTENCE_PATTERNS = [
  /不是.{1,20}而是/,
  /越.{1,10}越/,
  /这才是.{1,20}的地方/,
  /折射出/,
  /某种程度上/,
  /不妨/,
  /也许正是/,
  /恰恰是/,
  /背后是/,
  /让我们.{1,15}[吧。]/,
  /值得我们/,
  /意味着什么/,
  /本质上/,
  /深层/
];

async function deAIPass(articlePackage, logger = null) {
  if (!deepseekApiKey) {
    return articlePackage;
  }

  const targets = [];
  for (let sectionIndex = 0; sectionIndex < articlePackage.article.sections.length; sectionIndex++) {
    const section = articlePackage.article.sections[sectionIndex];
    for (let paragraphIndex = 0; paragraphIndex < (section.paragraphs || []).length; paragraphIndex++) {
      const text = String(section.paragraphs[paragraphIndex]);
      const score = AI_SENTENCE_PATTERNS.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
      if (score > 0) {
        targets.push({ sectionIndex, paragraphIndex, text, score });
      }
    }
  }

  const toFix = targets.sort((a, b) => b.score - a.score).slice(0, 4);
  logger?.info('deAI targets selected', {
    targetCount: targets.length,
    fixingCount: toFix.length
  });
  if (toFix.length === 0) {
    return articlePackage;
  }

  const separator = '\n<<<SEP>>>\n';
  const rewriteResponse = await callDeepSeekChat({
    messages: [
      {
        role: 'system',
        content: [
          '你在帮公众号作者改稿。',
          '把下面每句话里的总结感、AI腔、升华句去掉。',
          '改成更具体、更像人说话的表达。保持原意，不要加新内容，不要解释。',
          '每句用 <<<SEP>>> 分隔，保持顺序。'
        ].join('\n')
      },
      {
        role: 'user',
        content: toFix.map((target) => target.text).join(separator)
      }
    ],
    temperature: 0.7,
    logger
  });

  if (!rewriteResponse) {
    logger?.warn('deAI rewrite skipped; empty response');
    return articlePackage;
  }

  const rewrites = rewriteResponse.split(separator).map((text) => text.trim()).filter(Boolean);
  logger?.info('deAI rewrite completed', {
    rewriteCount: rewrites.length
  });
  const result = JSON.parse(JSON.stringify(articlePackage));
  for (let index = 0; index < Math.min(toFix.length, rewrites.length); index++) {
    if (rewrites[index]) {
      result.article.sections[toFix[index].sectionIndex].paragraphs[toFix[index].paragraphIndex] = rewrites[index];
    }
  }
  return result;
}

function validateArticlePackage(articlePackage) {
  const errors = [];
  if (!articlePackage.readerNote || typeof articlePackage.readerNote.rawFeeling !== 'string') {
    errors.push('readerNote is required');
  }
  if (!Array.isArray(articlePackage.titles) || articlePackage.titles.length !== 6) {
    errors.push('titles must contain 6 items');
  }
  const sections = articlePackage.article?.sections || [];
  if (!Array.isArray(sections) || sections.length < 5 || sections.length > 6) {
    errors.push('sections must contain 5-6 items');
  }
  if (!articlePackage.article?.closingCallToAction) {
    errors.push('closingCallToAction is required');
  }
  const inlineImages = articlePackage.visual?.inlineImages || [];
  if (!Array.isArray(inlineImages) || inlineImages.length !== 3) {
    errors.push('inlineImages must contain 3 items');
  }
  if (!Array.isArray(articlePackage.momentsCopy) || articlePackage.momentsCopy.length !== 2) {
    errors.push('momentsCopy must contain 2 items');
  }
  if (!Array.isArray(articlePackage.interactionPrompts) || articlePackage.interactionPrompts.length !== 2) {
    errors.push('interactionPrompts must contain 2 items');
  }
  if (!Array.isArray(articlePackage.tags) || articlePackage.tags.length !== 4) {
    errors.push('tags must contain 4 items');
  }
  errors.push(...lintHumanVoice(articlePackage));
  return errors;
}

function collectArticleText(articlePackage) {
  const parts = [];
  parts.push(articlePackage.abstract?.text || '');
  for (const title of articlePackage.titles || []) {
    parts.push(title.title || '');
  }
  const note = articlePackage.readerNote || {};
  parts.push(note.rawFeeling || '', note.readingMoment || '', note.oneSceneRemembered || '', note.personalQuestion || '');
  for (const section of articlePackage.article?.sections || []) {
    parts.push(section.title || '');
    parts.push(...(section.paragraphs || []));
    parts.push(...(section.items || []));
  }
  parts.push(articlePackage.article?.closingCallToAction || '');
  parts.push(...(articlePackage.interactionPrompts || []));
  return parts.join('\n');
}

function lintHumanVoice(articlePackage) {
  const errors = [];
  const text = collectArticleText(articlePackage);
  const forbiddenHeadings = [
    '核心洞察',
    '为什么值得',
    '值得每个人读',
    '适合谁读',
    '留个问题',
    '人间值得',
    '重新理解',
    '重新校准'
  ];
  const templateTerms = [
    '核心洞察',
    '值得每个人读',
    '重新理解',
    '重新校准',
    '底层逻辑',
    '坐标',
    '真正的',
    '其实',
    '很多时候',
    '我们总是',
    '你会发现',
    '这本书告诉我们',
    '在这个时代',
    '所谓',
    '人间值得',
    '全部的意义',
    '最大的回应',
    '评论区等你',
    '不提供鸡汤',
    '不输出成功学',
    '最直接的价值',
    '真正的功力',
    '折射出',
    '某种程度上',
    '不妨',
    '值得我们',
    '也许正是',
    '恰恰是',
    '深层',
    '让我们',
    '意味着什么',
    '本质上'
  ];

  const sectionTitles = (articlePackage.article?.sections || [])
    .map((section) => section.title || '')
    .filter(Boolean);
  const badHeading = sectionTitles.find((title) => forbiddenHeadings.some((term) => title.includes(term)));
  if (badHeading) {
    errors.push(`template heading detected: ${badHeading}`);
  }

  const titledSectionCount = sectionTitles.length;
  if (titledSectionCount > 2) {
    errors.push('too many section titles; keep at most 2 visible section titles');
  }

  const termHits = templateTerms.reduce((count, term) => count + (text.split(term).length - 1), 0);
  if (termHits > 5) {
    errors.push(`too many template terms: ${termHits}`);
  }

  const listLikeSections = (articlePackage.article?.sections || []).filter((section) => {
    const items = Array.isArray(section.items) ? section.items.length : 0;
    const shortParagraphs = (section.paragraphs || []).filter((paragraph) => String(paragraph).length < 35).length;
    return items >= 4 || shortParagraphs >= 4;
  });
  if (listLikeSections.length > 0) {
    errors.push('list-like plot summary detected');
  }

  const factRiskTriggers = [
    '书里有一个细节',
    '书里还有一处',
    '书里写到这里',
    '书里写到',
    '书里提到',
    '作者举了很多例子',
    '举了很多例子',
    '我反复看了两遍',
    '我愣了很久',
    '让我停下来想了很久',
    '制定了一套',
    '其中有一条',
    '明文规定',
    '必须留在',
    '当人质'
  ];
  const factRiskHits = factRiskTriggers.reduce((count, term) => count + (text.split(term).length - 1), 0);
  if (factRiskHits > 3) {
    errors.push(`too many specific fact-risk triggers: ${factRiskHits}`);
  }

  const paragraphs = (articlePackage.article?.sections || [])
    .flatMap((section) => section.paragraphs || [])
    .map((paragraph) => String(paragraph).trim())
    .filter(Boolean);
  const summaryPatterns = [
    /不是.+而是/,
    /越.+越/,
    /最终/,
    /本质/,
    /全部/,
    /最大/,
    /真正/,
    /意义/,
    /尊严/,
    /价值/
  ];
  const summaryLikeCount = paragraphs.filter((paragraph) => summaryPatterns.some((pattern) => pattern.test(paragraph))).length;
  if (summaryLikeCount > Math.max(4, Math.ceil(paragraphs.length / 3))) {
    errors.push(`too many summary-like paragraphs: ${summaryLikeCount}`);
  }

  let maxConsecutiveQuestions = 0;
  let questionStreak = 0;
  for (const paragraph of paragraphs) {
    if (paragraph.endsWith('？') || paragraph.endsWith('?')) {
      questionStreak++;
      maxConsecutiveQuestions = Math.max(maxConsecutiveQuestions, questionStreak);
    } else {
      questionStreak = 0;
    }
  }
  if (maxConsecutiveQuestions >= 2) {
    errors.push('consecutive question-ending paragraphs detected');
  }

  return errors;
}

function isPushedTitle(title) {
  const normalizedTitle = normalizeBookTitle(title);
  if (!normalizedTitle) return false;
  const row = db.prepare('SELECT id FROM pushed_books WHERE normalized_title = ?').get(normalizedTitle);
  return Boolean(row);
}

async function handleGenerate(req, res) {
  const logger = createRequestLogger('generate');
  const requestBody = await readRequestJson(req).catch(() => ({}));
  const theme = requestBody.theme || randomTheme();
  let candidatesPayload;
  let selectedBook = null;
  logger.info('generate request started', {
    theme,
    mock: !deepseekApiKey
  });

  for (let attempt = 0; attempt < 3 && !selectedBook; attempt++) {
    logger.info('recommend candidates attempt started', { attempt: attempt + 1 });
    candidatesPayload = await recommendCandidates(theme, logger);
    const candidates = Array.isArray(candidatesPayload.candidates) ? candidatesPayload.candidates : [];
    logger.info('recommend candidates attempt completed', {
      attempt: attempt + 1,
      candidateCount: candidates.length,
      candidateTitles: candidates.map((book) => book.title).slice(0, 8)
    });
    selectedBook = candidates.find((book) => !isPushedTitle(book.title));
  }

  if (!selectedBook) {
    logger.warn('no unpushed book found');
    jsonResponse(res, 409, {
      error: 'NO_UNPUSHED_BOOK',
      message: '候选书都已经推过，请稍后重试或清理去重库。'
    });
    return;
  }

  logger.info('selected book', {
    title: selectedBook.title,
    author: selectedBook.author,
    category: selectedBook.category
  });

  const rawReaderNote = await generateReaderNote(selectedBook, theme, logger);
  const readerNote = sanitizeReaderNote(rawReaderNote);
  logger.info('reader note ready', {
    rawFeelingLength: readerNote.rawFeeling.length,
    readingMomentLength: readerNote.readingMoment.length,
    oneSceneRememberedLength: readerNote.oneSceneRemembered.length,
    personalQuestionLength: readerNote.personalQuestion.length,
    rawFeelingPreview: readerNote.rawFeeling
  });

  let articlePackage;
  let validationErrors = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    logger.info('article generation attempt started', {
      attempt: attempt + 1,
      retryFeedback: validationErrors
    });
    try {
      const rawArticlePackage = normalizeArticlePackage(
        await createArticle(selectedBook, theme, readerNote, logger, validationErrors),
        readerNote
      );
      logger.info('article generation attempt returned', {
        attempt: attempt + 1,
        titleCount: rawArticlePackage.titles?.length || 0,
        sectionCount: rawArticlePackage.article?.sections?.length || 0,
        inlineImageCount: rawArticlePackage.visual?.inlineImages?.length || 0
      });
      articlePackage = await deAIPass(rawArticlePackage, logger);
      validationErrors = validateArticlePackage(articlePackage);
      logger.info('article validation completed', {
        attempt: attempt + 1,
        valid: validationErrors.length === 0,
        validationErrors
      });
      if (validationErrors.length === 0) break;
    } catch (error) {
      validationErrors = [`generation attempt ${attempt + 1} failed: ${error.message}`];
      logger.warn('article generation attempt failed', {
        attempt: attempt + 1,
        message: error.message
      });
    }
  }

  if (validationErrors.length > 0) {
    logger.error('generate request failed validation', {
      validationErrors
    });
    jsonResponse(res, 422, {
      error: 'ARTICLE_VALIDATION_FAILED',
      validationErrors,
      articlePackage
    });
    return;
  }

  logger.info('generate request completed', {
    bookTitle: articlePackage.book?.title || selectedBook.title,
    titleCount: articlePackage.titles?.length || 0,
    sectionCount: articlePackage.article?.sections?.length || 0
  });
  jsonResponse(res, 200, {
    requestId: logger.requestId,
    theme,
    selectedBook,
    articlePackage,
    mock: !deepseekApiKey
  });
}

async function handleMarkCopied(req, res) {
  const logger = createRequestLogger('mark-copied');
  const body = await readRequestJson(req);
  const bookTitle = String(body.bookTitle || '').trim();
  const normalizedTitle = normalizeBookTitle(bookTitle);
  if (!bookTitle || !normalizedTitle) {
    logger.warn('mark copied rejected; missing title');
    jsonResponse(res, 400, { error: 'BOOK_TITLE_REQUIRED' });
    return;
  }

  db.prepare(
    'INSERT OR IGNORE INTO pushed_books (book_title, normalized_title, copied_at) VALUES (?, ?, ?)'
  ).run(bookTitle, normalizedTitle, new Date().toISOString());

  logger.info('book marked copied', {
    bookTitle,
    normalizedTitle
  });
  jsonResponse(res, 200, {
    requestId: logger.requestId,
    ok: true,
    bookTitle,
    normalizedTitle
  });
}

function handlePushedBooks(res) {
  const rows = db.prepare('SELECT id, book_title, normalized_title, copied_at FROM pushed_books ORDER BY copied_at DESC').all();
  jsonResponse(res, 200, { books: rows });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (req.method === 'GET' && url.pathname === '/api/health') {
      jsonResponse(res, 200, { ok: true, mock: !deepseekApiKey });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/login') {
      if (isAuthenticated(req)) {
        redirectResponse(res, '/');
        return;
      }
      serveLoginPage(res, url.searchParams.has('error'));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      await handleAuthLogin(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      handleAuthLogout(res);
      return;
    }

    if (!requireAuth(req, res, url)) {
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/generate') {
      await handleGenerate(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/mark-copied') {
      await handleMarkCopied(req, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/pushed-books') {
      handlePushedBooks(res);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res);
      return;
    }

    jsonResponse(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  } catch (error) {
    console.error(error);
    jsonResponse(res, 500, { error: 'INTERNAL_ERROR', message: error.message });
  }
});

server.listen(port, () => {
  console.log(`Wechat book generator running at http://localhost:${port}`);
  if (!deepseekApiKey) {
    console.log('DEEPSEEK_API_KEY is not set; using mock generation data.');
  }
});
