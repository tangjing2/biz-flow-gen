#!/usr/bin/env node
/**
 * 业务流程图独立画布：按任意目录读写 业务流程.md + biz-flow.json。
 * 用法：node scripts/serve.mjs --dir "D:\\某业务目录" [--port 8790]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EDITOR_DIR = path.join(ROOT, 'editor');
const MD_NAME = '业务流程.md';
const JSON_NAME = 'biz-flow.json';

function parseArgs(argv) {
  const out = { dir: '', port: 8790 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir' || a === '-d') out.dir = String(argv[++i] || '');
    else if (a === '--port' || a === '-p') out.port = Number(argv[++i]) || 8790;
    else if (a.startsWith('--dir=')) out.dir = a.slice(6);
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7)) || 8790;
  }
  return out;
}

function send(res, status, body, extraHeaders = {}) {
  const isBuf = Buffer.isBuffer(body);
  const isStr = typeof body === 'string';
  const headers = {
    'Cache-Control': 'no-store',
    ...extraHeaders,
  };
  if (isBuf) {
    headers['Content-Length'] = body.length;
  } else if (isStr) {
    headers['Content-Type'] = headers['Content-Type'] || 'text/plain; charset=utf-8';
  }
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function mimeOf(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  }[ext] || 'application/octet-stream';
}

function safeResolveDir(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const resolved = path.resolve(String(raw).trim());
  if (!resolved || resolved.includes('\0')) return '';
  return resolved;
}

function wrapMermaidMd(title, mermaidBody, existingMd = '') {
  const body = String(mermaidBody || '').trimEnd() + '\n';
  const fence = '```mermaid\n' + body + '```\n';
  const src = String(existingMd || '');
  const start = src.indexOf('```mermaid');
  if (start >= 0) {
    const afterStart = src.indexOf('\n', start);
    const end = src.indexOf('```', afterStart >= 0 ? afterStart + 1 : start + 10);
    if (end >= 0) {
      const head = src.slice(0, start);
      const tail = src.slice(end + 3);
      return `${head}${fence}${tail.replace(/^\r?\n/, '\n')}`;
    }
  }
  const safeTitle = title || '业务流程图';
  return `# ${safeTitle} · 业务流程\n\n打开本文件后用 **Markdown Preview**（\`Ctrl+Shift+V\`）查看。\n\n${fence}`;
}

function readDoc(dir) {
  const jsonPath = path.join(dir, JSON_NAME);
  const mdPath = path.join(dir, MD_NAME);
  const title = path.basename(dir) || '业务流程图';
  if (fs.existsSync(jsonPath)) {
    try {
      const raw = fs.readFileSync(jsonPath, 'utf8');
      const doc = JSON.parse(raw);
      if (doc && Array.isArray(doc.nodes)) {
        return { ok: true, source: 'json', doc, title: doc.title || title };
      }
    } catch {
      /* fall through to mermaid */
    }
  }
  if (fs.existsSync(mdPath)) {
    const mermaidSrc = fs.readFileSync(mdPath, 'utf8');
    return { ok: true, source: 'mermaid', mermaidSrc, title };
  }
  return { ok: true, source: 'empty', title };
}

function writeDoc(dir, payload) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, JSON_NAME);
  const mdPath = path.join(dir, MD_NAME);
  const title = payload.doc?.title || payload.title || path.basename(dir);
  const existingMd = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
  const md = wrapMermaidMd(title, payload.mermaid || '', existingMd);
  fs.writeFileSync(jsonPath, JSON.stringify(payload.doc, null, 2) + '\n', 'utf8');
  fs.writeFileSync(mdPath, md, 'utf8');
  return { ok: true, mermaidSynced: true, mdPath, jsonPath };
}

function serveStatic(reqPath, res) {
  let rel = decodeURIComponent(reqPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(EDITOR_DIR, rel.replace(/^[/\\]+/, '')));
  if (!filePath.startsWith(EDITOR_DIR)) {
    send(res, 403, 'forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    send(res, 404, 'not found');
    return;
  }
  send(res, 200, fs.readFileSync(filePath), { 'Content-Type': mimeOf(filePath) });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function dirFromUrl(url, fallbackDir) {
  const q = new URL(url, 'http://127.0.0.1').searchParams.get('dir');
  return safeResolveDir(q || fallbackDir);
}

const args = parseArgs(process.argv);
const fallbackDir = safeResolveDir(args.dir);

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const pathname = url.split('?')[0];

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    send(res, 204, '');
    return;
  }

  if (pathname === '/api/doc' && req.method === 'GET') {
    const dir = dirFromUrl(url, fallbackDir);
    if (!dir) {
      sendJson(res, 400, { ok: false, error: '缺少 dir：请用 ?dir=落盘目录 或 --dir' });
      return;
    }
    try {
      sendJson(res, 200, readDoc(dir));
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (pathname === '/api/doc' && req.method === 'POST') {
    try {
      const payload = await readBody(req);
      const dir = safeResolveDir(payload.dir || dirFromUrl(url, fallbackDir));
      if (!dir) {
        sendJson(res, 400, { ok: false, error: '缺少 dir' });
        return;
      }
      if (!payload.doc) {
        sendJson(res, 400, { ok: false, error: '缺少 doc' });
        return;
      }
      sendJson(res, 200, writeDoc(dir, payload));
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (pathname === '/api/health') {
    sendJson(res, 200, { ok: true, dir: fallbackDir });
    return;
  }

  serveStatic(url, res);
});

server.listen(args.port, '127.0.0.1', () => {
  const dirQ = fallbackDir ? `?dir=${encodeURIComponent(fallbackDir)}` : '';
  const url = `http://127.0.0.1:${args.port}/${dirQ}`;
  console.log(`[biz-flow] editor ${url}`);
  if (fallbackDir) console.log(`[biz-flow] dir ${fallbackDir}`);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[biz-flow] 端口 ${args.port} 已被占用，换一个：node scripts/serve.mjs --dir "..." --port ${args.port + 1}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
