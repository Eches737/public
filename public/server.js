// Compact canonical server.js
import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import morgan from 'morgan';
import { parseStringPromise } from 'xml2js';
import fs from 'fs/promises';
import crypto from 'crypto';
import os from 'os';
import argon2 from 'argon2';
import { URLSearchParams } from 'url';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3001);
const ORIGIN = process.env.CORS_ORIGIN || '*';
const APP_CONTACT = process.env.APP_CONTACT || 'contact@example.com';

app.use(cors({ origin: ORIGIN }));
app.use(morgan('dev'));
app.use(express.json());

// Serve static files from the `public` directory (JS/CSS/assets).
// Place this before API routes so requests for /list-core.js, /app.js, etc. return
// the real file instead of falling through to an HTML fallback or 404.
// server.js already lives in the `public/` folder in this project layout,
// so serve static assets directly from __dirname instead of __dirname/public
// which would resolve to .../public/public and cause 404s.
const STATIC_ROOT = __dirname;
// serve static files and allow index files (so '/' returns public/index.html)
app.use(express.static(STATIC_ROOT));

// Serve the project's root index.html (project root contains index.html)
const ROOT_INDEX = path.join(__dirname, '..', 'index.html');
app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(ROOT_INDEX, (err) => {
    if (err) {
      console.warn('Failed to send root index.html', err);
      res.status(err.status || 404).send('Not Found');
    }
  });
});

// Debug status route to help identify which server process is responding.
// Call this after restarting the server to confirm the running process and paths.
app.get('/_status', (req, res) => {
  res.json({
    ok: true,
    pid: process.pid,
    cwd: process.cwd(),
    staticRoot: STATIC_ROOT,
    rootIndex: ROOT_INDEX
  });
});

// Content Security Policy (개발용)
// 개발 중 브라우저가 로컬 백엔드(예: :3001)로의 fetch/connect 요청을 차단하지 않도록 허용합니다.
// 운영 환경에서는 이 설정을 더 엄격하게 구성하세요.
app.use((req, res, next) => {
  try {
    const csp = [
      "default-src 'self' data: blob: 'unsafe-inline'",
      "connect-src 'self' http://localhost:3001 ws://localhost:3001",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:"
    ].join('; ');
    res.setHeader('Content-Security-Policy', csp);
  } catch (e) {
    console.warn('Failed to set CSP header', e);
  }
  return next();
});

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const toInt = (v, def) => (isNaN(parseInt(v, 10)) ? def : parseInt(v, 10));
const isYear = (v) => /^\d{4}$/.test(String(v || '').trim());
const UA = `PaperScout/1.0 (+${APP_CONTACT})`;
function stripHTML(html){ return String(html||'').replace(/<[^>]+>/g,'').trim(); }
function cryptoRandomId(){ return globalThis.crypto?.randomUUID ? crypto.randomUUID() : 'id-'+Math.random().toString(36).slice(2); }



async function fetchJSON(u, init={}){ const r=await fetch(u,{...init,headers:{'User-Agent':UA, ...(init.headers||{})}}); if(!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.json(); }
async function fetchText(u, init={}){ const r=await fetch(u,{...init,headers:{'User-Agent':UA, ...(init.headers||{})}}); if(!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.text(); }

async function searchCrossref({q,page,pageSize,sort,yFrom,yTo,journal}){
  const params=new URLSearchParams(); if(q) params.set('query',q); params.set('rows',String(pageSize)); params.set('offset',String((page-1)*pageSize)); params.set('mailto',APP_CONTACT);
  if(sort==='date_desc'||sort==='date_asc'){ params.set('sort','published'); params.set('order', sort==='date_desc'?'desc':'asc'); }
  if(isYear(yFrom)) params.append('filter',`from-pub-date:${yFrom}-01-01`);
  if(isYear(yTo)) params.append('filter',`until-pub-date:${yTo}-12-31`);
  if(journal) params.set('query.container-title',journal);
  const url=`https://api.crossref.org/works?${params.toString()}`;
  const data=await fetchJSON(url);
  const total=data?.message?.['total-results']||0;
  const items=(data?.message?.items||[]).map(it=>({
    id: it.DOI||it.URL||cryptoRandomId(),
    title: (it.title&&it.title[0])||'',
    url: it.URL||(it.DOI?`https://doi.org/${it.DOI}`:''),
    year: it['published-print']?.['date-parts']?.[0]?.[0]||it['published-online']?.['date-parts']?.[0]?.[0]||null,
    journal: (it['container-title']&&it['container-title'][0])||'',
    authors: (it.author||[]).map(a=>[a?.family,a?.given].filter(Boolean).join(', ')).filter(Boolean),
    abstract: stripHTML(it.abstract||''), keywords: Array.isArray(it.subject)?it.subject.slice(0,8):[]
  }));
  return { total, items };
}

async function searchArxiv({q,page,pageSize,sort,yFrom,yTo,journal}){
  const searchTerms=[]; if(q) searchTerms.push(`all:${q.replace(/[:\"]/g,' ')}`); if(journal) searchTerms.push(`all:${journal.replace(/[:\"]/g,' ')}`);
  const query=searchTerms.length?searchTerms.join('+AND+'):'all:science';
  const start=(page-1)*pageSize; const url=`http://export.arxiv.org/api/query?search_query=${query}&start=${start}&max_results=${pageSize}`;
  const xml=await fetchText(url); const parsed=await parseStringPromise(xml,{explicitArray:true,trim:true});
  const entries=parsed?.feed?.entry||[];
  const items=entries.map(e=>({ id:(e.id&&e.id[0])||cryptoRandomId(), title:(e.title&&e.title[0])?.replace(/\s+/g,' ').trim()||'', url:(e.link||[])[0]?.$.href||(e.id&&e.id[0])||'', authors:(e.author||[]).map(a=>a.name?.[0]).filter(Boolean), abstract:(e.summary&&e.summary[0])?.replace(/\s+/g,' ').trim()||'', year:(e.published&&e.published[0])?new Date(e.published[0]).getUTCFullYear():null, journal: e['arxiv:journal_ref']?.[0]||'' }));
  return { total: start+items.length, items };
}

// 헬스 체크: 단순 JSON 응답으로 모니터링/프론트 호환성 제공
app.get('/health', (_req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || 'development', ts: new Date().toISOString() });
});

app.get('/api/search', async (req,res,next)=>{
  try{
    const { q='', source='crossref', page='1', pageSize='10', sort='relevance', yFrom='', yTo='', journal='' }=req.query;
    const p=clamp(toInt(page,1),1,1000); const ps=clamp(toInt(pageSize,10),1,100);
    const common={q, page:p, pageSize:ps, sort, yFrom, yTo, journal};
    let data;
    if(source==='arxiv') data=await searchArxiv(common);
    else data=await searchCrossref(common);
    res.json({ ok:true, query:{...common,source}, total:data.total, items:data.items });
  }catch(e){ next(e); }
});

app.get('/api/publishers', async (_req,res)=>{
  try{ const p=path.join(__dirname,'publishers.json'); const text=await fs.readFile(p,'utf8'); res.type('application/json').send(text); }catch(e){ res.status(500).json({ok:false,error:'not found'}); }
});

app.get('/proxy', async (req,res)=>{
  const url=String(req.query.url||''); if(!url) return res.status(400).json({ok:false,error:'missing url'});
  try{ const r=await fetch(url,{headers:{'User-Agent':UA}}); res.status(r.status); r.headers.forEach((v,k)=>{ if(k.toLowerCase()!=='transfer-encoding') res.setHeader(k,v); }); const body=await r.arrayBuffer(); res.send(Buffer.from(body)); }catch(e){ res.status(502).json({ok:false,error:String(e)}); }
});

app.get('/api/probe', (_req,res)=> res.json({ ok:true, env: process.env.NODE_ENV||'dev' }));

// Serve DevTools app-specific manifest to avoid 404 noise when Chrome devtools probes
app.get('/.well-known/appspecific/com.chrome.devtools.json', (_req, res) => {
  // Minimal response — Chrome devtools expects this path for local tooling; returning
  // an empty object is harmless and prevents 404 errors in the browser console.
  res.type('application/json').send(JSON.stringify({ ok: true }));
});

// Proxy/search to a specific publisher API using configured API keys from admin config.
// Example: GET /api/publisher/search?publisher=springer&q=deep+learning
app.get('/api/publisher/search', async (req, res) => {
  try{
    const pubId = String(req.query.publisher || '');
    const q = String(req.query.q || req.query.query || '');
    if(!pubId) return res.status(400).json({ ok:false, error: 'missing publisher id' });
    // load publisher catalog
    const pubPath = path.join(__dirname,'publishers.json');
    let catalog = null;
    try{ catalog = JSON.parse(await fs.readFile(pubPath,'utf8')); }catch(e){ catalog = { publishers: [] }; }
    const pub = (catalog.publishers||[]).find(p => String(p.id) === pubId);
    if(!pub) return res.status(404).json({ ok:false, error:'publisher not found' });
    if(!pub.apiUrl) return res.status(400).json({ ok:false, error:'publisher has no apiUrl' });

    // build target URL
    let target = pub.apiUrl;
    // if apiUrl contains {query} replace it
    if(q && target.includes('{query}')){
      target = target.replace(/\{query\}/g, encodeURIComponent(q));
    }
    // otherwise append as q param
    const u = new URL(target);
    if(q && !target.includes('{query}')){
      if(!u.searchParams.has('q') && !u.searchParams.has('query')) u.searchParams.set('q', q);
    }
    // pass pagination hints
    if(req.query.page) u.searchParams.set('page', String(req.query.page));
    if(req.query.pageSize) u.searchParams.set('pageSize', String(req.query.pageSize));

    // attach configured API key from admin config (if any)
    let adminCfg = {};
    try{ adminCfg = await readAdminConfig(); }catch(e){ adminCfg = {}; }
    const cfgKeys = (adminCfg && adminCfg.publishers) || {};
    const key = cfgKeys[pubId] || cfgKeys[pubId.toLowerCase()];

    const headers = { 'User-Agent': UA };
    if(key){
      // best-effort: provide key in Authorization header and common query params
      headers['Authorization'] = `Bearer ${key}`;
      // add as query params as well
      u.searchParams.set('api_key', key);
      u.searchParams.set('apikey', key);
      u.searchParams.set('key', key);
    }

    const r = await fetch(u.toString(), { headers });
    const contentType = r.headers.get('content-type') || '';
    const body = await r.arrayBuffer();
    // forward content-type
    res.status(r.status);
    if(contentType) res.setHeader('Content-Type', contentType);
    return res.send(Buffer.from(body));
  }catch(e){ console.error('publisher proxy failed', e); return res.status(502).json({ ok:false, error: String(e) }); }
});

// Simple AI summarization endpoint (development). Accepts { text, url, title } and returns a small summary.
app.post('/api/ai/summarize', express.json(), async (req, res) => {
  try{
    const body = req.body || {};
    let text = String(body.text || '');
    const title = String(body.title || '');
    if(!text && body.url){
      // try to fetch URL and extract text (best-effort)
      try{ const r = await fetch(body.url, { headers: { 'User-Agent': UA } }); if(r.ok) text = await r.text(); }catch(e){}
    }
    if(!text) return res.status(400).json({ ok:false, error:'missing text or url' });

    // Naive summarization: try to find abstract-like block, else pick leading sentences
    function splitSentences(s){ return s.replace(/\s+/g,' ').trim().match(/[^.!?]+[.!?]?/g) || [s]; }
    const lower = String(text).toLowerCase();
    let summary = '';
    // try extract 'abstract' section
    const m = text.match(/abstract[:\s\n]+([\s\S]{50,1000}?)(\n\s*\n|\r\n\r\n|\n\n|$)/i);
    if(m && m[1]){
      const sents = splitSentences(m[1]);
      summary = sents.slice(0,3).join(' ').trim();
    } else {
      const sents = splitSentences(text);
      summary = sents.slice(0,3).join(' ').trim();
    }

    // bullets: extract keywords by frequency (simple)
    const words = text.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w=>w.length>4);
    const freq = {};
    for(const w of words) freq[w]=(freq[w]||0)+1;
    const kws = Object.keys(freq).sort((a,b)=>freq[b]-freq[a]).slice(0,6);

    return res.json({ ok:true, title: title||null, summary, bullets: kws });
  }catch(e){ console.error('ai summarize failed', e); return res.status(500).json({ ok:false, error: String(e) }); }
});

app.use((err,_req,res,_next)=>{ console.error(err && err.stack?err.stack:err); res.status(500).json({ ok:false, error: String(err) }); });
// --- Security middlewares & helpers ------------------------------------------

// HSTS - instruct browsers to prefer HTTPS (safe to include in dev; browsers ignore on HTTP)
app.use((req,res,next)=>{
  try{ res.setHeader('Strict-Transport-Security','max-age=63072000; includeSubDomains; preload'); }catch(e){}
  next();
});

// Enforce TLS for sensitive endpoints unless running on localhost (dev convenience)
function requireTLS(req,res,next){
  const host = (req.headers.host||'').split(':')[0];
  const forwardedProto = (req.headers['x-forwarded-proto']||'').toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';
  const secure = req.secure || forwardedProto === 'https' || isLocal;
  if(!secure){
    return res.status(403).json({ ok:false, error: 'TLS required' });
  }
  return next();
}

// Password hashing helpers using Argon2id (recommended for production)
const AUTH_PEPPER = process.env.AUTH_PEPPER || '';
const ARGON2_MEMORY_KB = Number(process.env.ARGON2_MEMORY_KB || 65536); // 64 MB
const ARGON2_TIME = Number(process.env.ARGON2_TIME || 3);
const ARGON2_PARALLEL = Number(process.env.ARGON2_PARALLEL || Math.max(1, os.cpus().length));

async function hashPasswordArgon2(password){
  const input = String(password) + (AUTH_PEPPER || '');
  // argon2.hash returns encoded string containing salt and params
  return await argon2.hash(input, {
    type: argon2.argon2id,
    memoryCost: ARGON2_MEMORY_KB,
    timeCost: ARGON2_TIME,
    parallelism: ARGON2_PARALLEL
  });
}

async function verifyPasswordArgon2(storedHash, password){
  try{
    const input = String(password) + (AUTH_PEPPER || '');
    return await argon2.verify(storedHash, input);
  }catch(e){ return false; }
}

// Simple in-memory login attempt tracker to mitigate brute-force
const loginAttemptsByUser = new Map(); // user -> { count, lastFailedAt, lockUntil }
const loginAttemptsByIp = new Map(); // ip -> { count, lastFailedAt, lockUntil }
function recordFailedAttempt({ keyMap, key }){
  const now = Date.now();
  const st = keyMap.get(key) || { count:0, lastFailedAt:0, lockUntil:0 };
  st.count = (st.count||0) + 1; st.lastFailedAt = now;
  // exponential backoff: lock for min(5m * 2^(count-5), 24h) once count>=5
  if(st.count >= 5){
    const extraMinutes = Math.min(5 * Math.pow(2, st.count - 5), 60 * 24);
    st.lockUntil = now + extraMinutes * 60 * 1000;
  }
  keyMap.set(key, st);
}
function clearAttempts(keyMap, key){ keyMap.delete(key); }
function isLocked(keyMap, key){ const s = keyMap.get(key); return s && s.lockUntil && Date.now() < s.lockUntil; }

// --- Simple dev auth endpoints ------------------------------------------------
// Token format: base64url(JSON) + '.' + hex(hmac_sha256(secret, base64url(JSON)))
const AUTH_SECRET = process.env.AUTH_SECRET || 'dev-secret-please-change';
// Simple in-memory user store for development. Supply via AUTH_USERS env as JSON array
// Example: AUTH_USERS='[{"username":"admin","password":"password"}]'
let AUTH_USERS = [{ username: 'admin', password: 'password' }];
try{
  if(process.env.AUTH_USERS) {
    const parsed = JSON.parse(process.env.AUTH_USERS);
    if(Array.isArray(parsed)) AUTH_USERS = parsed;
  }
}catch(e){ console.warn('Failed to parse AUTH_USERS env; using default dev user'); }

// Normalize AUTH_USERS asynchronously: if entry has plaintext `password`, replace with { pwd_hash }
// We keep everything in-memory; in production use a persistent user DB with hashed passwords.
async function initAuthUsers(){
  try{
    const out = [];
    for(const u of AUTH_USERS){
      if(!u) continue;
      const username = String(u.username || u.user || u.name || '').trim();
      if(!username) continue;
      if(u.pwd_hash){
        // assume already Argon2 encoded hash
        out.push({ username, pwd_hash: String(u.pwd_hash) });
        continue;
      }
      if(u.password){
        // Hash plaintext password using argon2 (development convenience)
        try{
          const pwd_hash = await hashPasswordArgon2(u.password);
          console.log(`Auth: created argon2 hash for user=${username} (development only)`);
          out.push({ username, pwd_hash });
        }catch(e){ console.error('Auth: argon2 hash failed for user', username, e); }
        continue;
      }
    }
    AUTH_USERS = out;
  }catch(e){ console.warn('Failed to initialize AUTH_USERS hashing', e); }
}
function base64url(input){ return Buffer.from(input).toString('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_'); }
function base64urlDecode(s){ s = s.replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4) s+='='; return Buffer.from(s,'base64').toString('utf8'); }
function signPayload(obj){ const json = JSON.stringify(obj); const b = base64url(json); const sig = crypto.createHmac('sha256', AUTH_SECRET).update(b).digest('hex'); return `${b}.${sig}`; }
function verifyToken(token){ try{ if(!token || typeof token !== 'string') return null; const parts = token.split('.'); if(parts.length!==2) return null; const [b,sig] = parts; const expected = crypto.createHmac('sha256', AUTH_SECRET).update(b).digest('hex'); if(!crypto.timingSafeEqual(Buffer.from(expected,'hex'), Buffer.from(sig,'hex'))) return null; const payload = JSON.parse(base64urlDecode(b)); if(payload.exp && Date.now() > payload.exp) return null; return payload; }catch(e){ return null; } }

app.post('/api/auth/login', requireTLS, async (req,res)=>{
  try{
    const { username, password } = req.body || {};
    const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';

    // Uniform error message to avoid account enumeration
    const genericErr = { ok:false, error:'invalid username or password' };

    // Check lockouts
    if(isLocked(loginAttemptsByIp, clientIp)){
      console.warn(`Auth: IP locked out ${clientIp}`);
      return res.status(429).json(genericErr);
    }

    if(!username || !password){
      console.warn('Auth: missing credentials', { ip: clientIp });
      // record failed attempt keyed by IP only
      recordFailedAttempt({ keyMap: loginAttemptsByIp, key: clientIp });
      return res.status(401).json(genericErr);
    }

    const user = AUTH_USERS.find(u => u.username === String(username));
    if(!user){
      // Do not reveal account absence
      console.warn('Auth: login failed - user not found', { username, ip: clientIp });
      recordFailedAttempt({ keyMap: loginAttemptsByIp, key: clientIp });
      recordFailedAttempt({ keyMap: loginAttemptsByUser, key: username });
      return res.status(401).json(genericErr);
    }

    // Check per-user lockout
    if(isLocked(loginAttemptsByUser, username)){
      console.warn(`Auth: user locked out ${username}`, { ip: clientIp });
      return res.status(429).json(genericErr);
    }

  // Verify password using Argon2 (async)
  const ok = await verifyPasswordArgon2(user.pwd_hash, password);
    if(!ok){
      console.warn('Auth: invalid password', { username, ip: clientIp });
      recordFailedAttempt({ keyMap: loginAttemptsByIp, key: clientIp });
      recordFailedAttempt({ keyMap: loginAttemptsByUser, key: username });
      return res.status(401).json(genericErr);
    }

    // Success: clear failure counters
    clearAttempts(loginAttemptsByIp, clientIp);
    clearAttempts(loginAttemptsByUser, username);

    const ttl = Number(process.env.AUTH_TTL_MS) || (1000 * 60 * 60); // 1 hour default
    const payload = { user: { name: String(user.username) }, iat: Date.now(), exp: Date.now() + ttl };
    const token = signPayload(payload);
    return res.json({ ok:true, token, user: payload.user });
  }catch(e){ console.error('Auth: login handler error', e); return res.status(500).json({ ok:false, error: 'internal error' }); }
});

app.get('/api/auth/verify', (req,res)=>{
  try{
    const h = req.headers['authorization'] || '';
    const m = String(h).match(/^Bearer\s+(.+)$/i);
    if(!m) return res.status(401).json({ ok:false, error:'missing auth' });
    const token = m[1]; const payload = verifyToken(token);
    if(!payload) return res.status(401).json({ ok:false, error:'invalid or expired token' });
    return res.json({ ok:true, user: payload.user });
  }catch(e){ return res.status(500).json({ ok:false, error: String(e) }); }
});

// Token exchange endpoint for Authorization Code (PKCE)
app.post('/auth/callback', express.json(), async (req, res) => {
  try {
    const { code, code_verifier } = req.body || {};
    if (!code) return res.status(400).json({ ok: false, error: 'missing code' });

    const COGNITO_DOMAIN = process.env.COGNITO_DOMAIN; // e.g. your-domain.auth.us-east-1.amazoncognito.com
    const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
    const REDIRECT_URI = process.env.COGNITO_REDIRECT_URI; // must match app client setting
    if (!COGNITO_DOMAIN || !CLIENT_ID || !REDIRECT_URI) {
      console.error('Cognito env not configured');
      return res.status(500).json({ ok: false, error: 'server not configured' });
    }

    const tokenUrl = `https://${COGNITO_DOMAIN}/oauth2/token`;
    const params = new URLSearchParams();
    params.set('grant_type', 'authorization_code');
    params.set('client_id', CLIENT_ID);
    params.set('code', code);
    params.set('redirect_uri', REDIRECT_URI);
    if (code_verifier) params.set('code_verifier', code_verifier);

    const r = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    if (!r.ok) {
      const tb = await r.text();
      console.error('Token endpoint error', r.status, tb);
      return res.status(502).json({ ok: false, error: 'token exchange failed', detail: tb });
    }

    const data = await r.json();
    // set tokens as HttpOnly cookies (access_token, id_token)
    const secure = (process.env.NODE_ENV === 'production');
    if (data.id_token) res.cookie('id_token', data.id_token, { httpOnly: true, secure });
    if (data.access_token) res.cookie('access_token', data.access_token, { httpOnly: true, secure });
    if (data.refresh_token) res.cookie('refresh_token', data.refresh_token, { httpOnly: true, secure });

    return res.json({ ok: true });
  } catch (e) {
    console.error('auth callback failed', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// JWT verification middleware using Cognito JWKS
const COGNITO_REGION = process.env.COGNITO_REGION || '';
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || '';
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID || process.env.COGNITO_APP_CLIENT_ID || '';
const COGNITO_ISSUER = (COGNITO_REGION && COGNITO_USER_POOL_ID) ? `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}` : null;

let jwks = null;
if (COGNITO_ISSUER) {
  const jwksUri = `${COGNITO_ISSUER}/.well-known/jwks.json`;
  jwks = jwksClient({ jwksUri, cache: true, cacheMaxEntries: 5, cacheMaxAge: 600000 });
}

function getKey(header, callback) {
  if (!jwks) return callback(new Error('JWKS not configured'));
  jwks.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    const pub = key.getPublicKey();
    callback(null, pub);
  });
}

function verifyJwtMiddleware(req, res, next) {
  try {
    const h = req.headers['authorization'] || '';
    const m = String(h).match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ ok: false, error: 'missing auth' });
    const token = m[1];
    if (!COGNITO_ISSUER || !COGNITO_CLIENT_ID) return res.status(500).json({ ok: false, error: 'server not configured for token verification' });

    jwt.verify(token, getKey, {
      audience: COGNITO_CLIENT_ID,
      issuer: COGNITO_ISSUER
    }, (err, payload) => {
      if (err) return res.status(401).json({ ok: false, error: 'invalid token', detail: err.message });
      req.user = payload;
      next();
    });
  } catch (e) {
    console.error('verifyToken error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
}

// Example protected route
app.get('/api/protected', verifyJwtMiddleware, (req, res) => {
  return res.json({ ok: true, user: req.user });
});

app.post('/api/auth/logout', (req,res)=>{
  // stateless token: best-effort endpoint for clients. To actually invalidate tokens,
  // implement server-side revocation (blacklist) — omitted for dev convenience.
  return res.json({ ok:true });
});

// --- User lists API (per-user storage) --------------------------------------
// Auth middleware: expects Bearer token and sets req.userName
function authMiddleware(req,res,next){
  try{
    const h = req.headers['authorization'] || '';
    const m = String(h).match(/^Bearer\s+(.+)$/i);
    if(!m) return res.status(401).json({ ok:false, error:'missing auth' });
    const token = m[1]; const payload = verifyToken(token);
    if(!payload || !payload.user || !payload.user.name) return res.status(401).json({ ok:false, error:'invalid or expired token' });
    req.userName = String(payload.user.name);
    return next();
  }catch(e){ return res.status(500).json({ ok:false, error: String(e) }); }
}

const DATA_DIR = path.join(__dirname, 'data');
async function ensureDataDir(){ try{ await fs.mkdir(DATA_DIR, { recursive:true }); }catch(e){} }
function userHash(name){ return crypto.createHmac('sha256', AUTH_SECRET).update(String(name)).digest('hex'); }
function userListsPath(name){ const h = userHash(name); return path.join(DATA_DIR, `userlists_${h}.json`); }

// Optional at-rest encryption for user data files.
// If AUTH_DATA_KEY is provided (env), files are stored as: ENC:<base64(iv||tag||ciphertext)>
const AUTH_DATA_KEY = process.env.AUTH_DATA_KEY || '';
function hasDataKey(){ return !!AUTH_DATA_KEY; }
function deriveDataKey(){
  // derive 32-byte key from provided secret using sha256
  return crypto.createHash('sha256').update(String(AUTH_DATA_KEY)).digest();
}
function encryptForStorage(plaintext){
  if(!hasDataKey()) return Buffer.from(plaintext,'utf8');
  const key = deriveDataKey(); const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext,'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = Buffer.concat([iv, tag, ct]);
  return Buffer.from(out).toString('base64');
}
function decryptFromStorage(b64){
  if(!hasDataKey()) return String(b64);
  try{
    const key = deriveDataKey(); const buf = Buffer.from(b64,'base64');
    const iv = buf.slice(0,12); const tag = buf.slice(12,28); const ct = buf.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  }catch(e){ console.error('decryptFromStorage failed', e); return null; }
}

// Optional Postgres/DB-backed storage. If DATABASE_URL is set and 'pg' is
// available, we will use the database for per-user lists and fall back to
// filesystem otherwise. To migrate existing files into the DB set
// MIGRATE_USERFILES=1 when starting the server.
const DATABASE_URL = process.env.DATABASE_URL || '';
let dbClient = null;
async function initDb(){
  if(!DATABASE_URL) return;
  try{
    const { Client } = await import('pg');
    dbClient = new Client({ connectionString: DATABASE_URL });
    await dbClient.connect();
    // Simple table to hold per-user lists. We allow either plaintext JSONB
    // in `lists` or application-level encrypted text in `enc_data` when
    // AUTH_DATA_KEY is used.
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS user_lists (
        user_hash TEXT PRIMARY KEY,
        username TEXT,
        lists JSONB,
        enc_data TEXT,
        is_encrypted BOOLEAN DEFAULT FALSE,
        updated_at TIMESTAMPTZ DEFAULT now()
      )
    `);
    console.log('DB: connected to', DATABASE_URL.replace(/:\d+\/.*$/, ':<redacted>'));
  }catch(e){ console.error('DB init failed (continuing with file storage)', e); dbClient = null; }
}

async function getUserListsDb(userName){
  if(!dbClient) return null;
  const h = userHash(userName);
  try{
    const r = await dbClient.query('SELECT lists, enc_data, is_encrypted FROM user_lists WHERE user_hash = $1', [h]);
    if(r.rowCount === 0) return null;
    const row = r.rows[0];
    if(row.is_encrypted){
      const dec = decryptFromStorage(row.enc_data);
      if(!dec) return null;
      return JSON.parse(dec);
    }
    return row.lists || null;
  }catch(e){ console.error('DB read failed', e); return null; }
}

async function saveUserListsDb(userName, lists){
  if(!dbClient) return false;
  const h = userHash(userName);
  try{
    if(hasDataKey()){
      const enc = encryptForStorage(JSON.stringify(lists));
      await dbClient.query(`INSERT INTO user_lists(user_hash, username, lists, enc_data, is_encrypted, updated_at)
        VALUES($1,$2,NULL,$3,TRUE,now())
        ON CONFLICT(user_hash) DO UPDATE SET enc_data = EXCLUDED.enc_data, is_encrypted=TRUE, updated_at=now()`,
        [h, String(userName), enc]);
    }else{
      await dbClient.query(`INSERT INTO user_lists(user_hash, username, lists, enc_data, is_encrypted, updated_at)
        VALUES($1,$2,$3,NULL,FALSE,now())
        ON CONFLICT(user_hash) DO UPDATE SET lists = EXCLUDED.lists, is_encrypted=FALSE, updated_at=now()`,
        [h, String(userName), lists]);
    }
    return true;
  }catch(e){ console.error('DB write failed', e); return false; }
}

// Variant that accepts precomputed user hash (useful for migration from files)
async function saveUserListsDbByHash(userHashHex, lists){
  if(!dbClient) return false;
  try{
    if(hasDataKey()){
      const enc = encryptForStorage(JSON.stringify(lists));
      await dbClient.query(`INSERT INTO user_lists(user_hash, username, lists, enc_data, is_encrypted, updated_at)
        VALUES($1,NULL,NULL,$2,TRUE,now())
        ON CONFLICT(user_hash) DO UPDATE SET enc_data = EXCLUDED.enc_data, is_encrypted=TRUE, updated_at=now()`,
        [userHashHex, enc]);
    }else{
      await dbClient.query(`INSERT INTO user_lists(user_hash, username, lists, enc_data, is_encrypted, updated_at)
        VALUES($1,NULL,$2,NULL,FALSE,now())
        ON CONFLICT(user_hash) DO UPDATE SET lists = EXCLUDED.lists, is_encrypted=FALSE, updated_at=now()`,
        [userHashHex, lists]);
    }
    return true;
  }catch(e){ console.error('DB write by hash failed', e); return false; }
}

// GET user's lists
app.get('/api/user/lists', authMiddleware, async (req,res)=>{
  try{
    await ensureDataDir();
    // Prefer DB when available
    if(dbClient){
      const lists = await getUserListsDb(req.userName);
      if(lists === null) return res.json({ ok:true, lists: [] });
      return res.json({ ok:true, lists });
    }
    // Fallback to filesystem
    const p = userListsPath(req.userName);
    try{
      const txt = await fs.readFile(p,'utf8');
      // Try JSON parse first; if that fails attempt decrypt then parse
      try{ return res.json({ ok:true, lists: JSON.parse(txt) }); }catch(_){ const dec = decryptFromStorage(txt); if(dec) return res.json({ ok:true, lists: JSON.parse(dec) }); throw _; }
    }catch(e){
      // not found -> empty lists
      if(e && e.code === 'ENOENT') return res.json({ ok:true, lists: [] });
      throw e;
    }
  }catch(e){ console.error('user lists read error', e); return res.status(500).json({ ok:false, error: 'failed to read lists' }); }
});

// POST save user's lists
app.post('/api/user/lists', authMiddleware, async (req,res)=>{
  try{
    const body = req.body || {};
    // Expect `lists` array or object
    const lists = body.lists === undefined ? body : body.lists;
    // Basic validation
    if(typeof lists === 'undefined') return res.status(400).json({ ok:false, error:'missing lists' });
    await ensureDataDir();
    // Prefer DB when available
    if(dbClient){
      const ok = await saveUserListsDb(req.userName, lists);
      if(ok) return res.json({ ok:true });
      // if DB write failed, fallthrough to filesystem fallback
    }
    const p = userListsPath(req.userName);
    // If AUTH_DATA_KEY is configured we will store encrypted blob on disk
    if(hasDataKey()){
      const enc = encryptForStorage(JSON.stringify(lists, null, 2));
      await fs.writeFile(p, enc, 'utf8');
    }else{
      await fs.writeFile(p, JSON.stringify(lists, null, 2), 'utf8');
    }
    return res.json({ ok:true });
  }catch(e){ console.error('user lists write error', e); return res.status(500).json({ ok:false, error:'failed to save lists' }); }
});

// --- Admin endpoints ------------------------------------------------------
function requireAdmin(req,res,next){
  try{
    const adminUser = process.env.ADMIN_USER || 'admin';
    if(req.userName === adminUser) return next();
    return res.status(403).json({ ok:false, error:'admin required' });
  }catch(e){ return res.status(500).json({ ok:false, error: String(e) }); }
}

const ADMIN_CONFIG_PATH = path.join(DATA_DIR, 'admin_config.json');
async function readAdminConfig(){
  await ensureDataDir();
  try{
    const txt = await fs.readFile(ADMIN_CONFIG_PATH, 'utf8');
    // if encrypted blob, decrypt
    try{ return JSON.parse(txt); }catch(_){ const dec = decryptFromStorage(txt); if(dec) return JSON.parse(dec); throw _; }
  }catch(e){
    if(e && e.code === 'ENOENT'){
      return { syncEnabled: true, publishers: {}, databaseUrl: process.env.DATABASE_URL || '' };
    }
    throw e;
  }
}

async function writeAdminConfig(cfg){
  await ensureDataDir();
  const txt = JSON.stringify(cfg, null, 2);
  if(hasDataKey()){
    const enc = encryptForStorage(txt);
    await fs.writeFile(ADMIN_CONFIG_PATH, enc, 'utf8');
  }else{
    await fs.writeFile(ADMIN_CONFIG_PATH, txt, 'utf8');
  }
}

app.get('/api/admin/config', authMiddleware, requireAdmin, async (req,res)=>{
  try{
    const cfg = await readAdminConfig();
    // don't leak secrets in API — mask nothing here because admin is authenticated
    return res.json({ ok:true, ...cfg });
  }catch(e){ console.error('admin config read failed', e); return res.status(500).json({ ok:false, error:'failed to read admin config' }); }
});

app.post('/api/admin/config', authMiddleware, requireAdmin, async (req,res)=>{
  try{
    const body = req.body || {};
    const cfg = await readAdminConfig();
    const prevDb = cfg.databaseUrl || '';
    cfg.syncEnabled = body.syncEnabled === undefined ? cfg.syncEnabled : !!body.syncEnabled;
    cfg.publishers = body.publishers === undefined ? cfg.publishers : body.publishers;
    cfg.databaseUrl = body.databaseUrl === undefined ? cfg.databaseUrl : String(body.databaseUrl || '');
    await writeAdminConfig(cfg);
    const restartRequired = prevDb !== (cfg.databaseUrl || '');
    return res.json({ ok:true, restartRequired, message: restartRequired ? 'DATABASE_URL 변경 — 서버 재시작 필요' : 'saved' });
  }catch(e){ console.error('admin config write failed', e); return res.status(500).json({ ok:false, error:'failed to save admin config' }); }
});

// Trigger the file->DB migration (admin only). Requires dbClient available.
app.post('/api/admin/migrate', authMiddleware, requireAdmin, async (req,res)=>{
  if(!dbClient) return res.status(400).json({ ok:false, error:'no database configured' });
  try{
    await ensureDataDir();
    const files = await fs.readdir(DATA_DIR);
    let migrated = 0; let skipped = 0;
    for(const f of files){
      const m = f.match(/^userlists_([0-9a-f]{64})\.json$/i);
      if(!m) continue;
      const hash = m[1];
      try{
        const txt = await fs.readFile(path.join(DATA_DIR, f), 'utf8');
        let lists = null;
        try{ lists = JSON.parse(txt); }catch(_){ const dec = decryptFromStorage(txt); if(dec) lists = JSON.parse(dec); }
        if(lists !== null){ await saveUserListsDbByHash(hash, lists); migrated++; }
        else skipped++;
      }catch(e){ console.warn('Migration: failed to migrate', f, e); skipped++; }
    }
    return res.json({ ok:true, migrated, skipped });
  }catch(e){ console.error('Migration endpoint failed', e); return res.status(500).json({ ok:false, error:'migration failed' }); }
});


// Ensure any plaintext AUTH_USERS are hashed before accepting requests
async function startServer(){
  try{
    await initAuthUsers();
    // Initialize DB if configured
    await initDb();
    // Optional one-time migration from file storage into DB
    if(dbClient && process.env.MIGRATE_USERFILES === '1'){
      try{
        await ensureDataDir();
        const files = await fs.readdir(DATA_DIR);
        let migrated = 0; let skipped = 0;
        for(const f of files){
          const m = f.match(/^userlists_([0-9a-f]{64})\.json$/i);
          if(!m) continue;
          const hash = m[1];
          try{
            const txt = await fs.readFile(path.join(DATA_DIR, f), 'utf8');
            let lists = null;
            try{ lists = JSON.parse(txt); }catch(_){ const dec = decryptFromStorage(txt); if(dec) lists = JSON.parse(dec); }
            if(lists !== null){ await saveUserListsDbByHash(hash, lists); migrated++; }
            else skipped++;
          }catch(e){ console.warn('Migration: failed to migrate', f, e); skipped++; }
        }
        console.log(`Migration: files -> DB completed. migrated=${migrated} skipped=${skipped}`);
      }catch(e){ console.error('Migration failed', e); }
    }
  }catch(e){ console.error('Failed to initialize auth users', e); }
  app.listen(PORT, ()=> console.log(`PaperScout API listening http://localhost:${PORT}`));
}

startServer();
