async function api(path, opts={}){
  // Try relative path first (same-origin), then fall back to backend on port 3001
  const token = localStorage.getItem('paperscout_auth_token');
  const headers = Object.assign({}, opts.headers || {});
  if(token) headers['Authorization'] = `Bearer ${token}`;
  if(!headers['Content-Type'] && !(opts && opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';

  async function doFetch(base){
    const url = base ? (base.replace(/\/$/, '') + path) : path;
    try{
      const r = await fetch(url, Object.assign({}, opts, { headers }));
      const txt = await r.text();
      try{ return { status: r.status, ok: r.ok, json: JSON.parse(txt), url }; }catch(e){ return { status: r.status, ok: r.ok, text: txt, url }; }
    }catch(e){ return { status: 0, ok:false, error: String(e), url }; }
  }

  // If the page is served from a different port than the API (common when using
  // python http.server for static files), avoid the noisy 404 by trying the
  // backend first. Allow overriding via global `window.API_BASE`.
  const configuredBase = (typeof window !== 'undefined' && window.API_BASE) ? String(window.API_BASE) : null;
  const currentPort = location.port || (location.protocol === 'https:' ? '443' : '80');
  const apiPort = '3001';
  let res = null;
  if(configuredBase){
    res = await doFetch(configuredBase);
  }else if(currentPort !== apiPort){
    // try backend first to avoid console 404 from static server
    const backendOrigin = `${location.protocol}//${location.hostname}:${apiPort}`;
    res = await doFetch(backendOrigin);
    // if backend not reachable, fall back to same-origin
    if(!res || (res.status && res.status === 0)){
      res = await doFetch('');
    }
  }else{
    // default: same-origin (API served from same host:port)
    res = await doFetch('');
  }
  return res;
}

function el(id){ return document.getElementById(id); }
async function refresh(){
  const who = localStorage.getItem('paperscout_auth_user')||'';
  el('who').textContent = who ? `로그인 사용자: ${who}` : '로그인 필요 (오른쪽 상단에서 로그인)';
  const r = await api('/api/admin/config');
  if(!r.ok){ el('out').textContent = `설정 불러오기 실패: ${r.status} ${JSON.stringify(r.json||r.text)}`; return; }
  const cfg = r.json || {};
  el('syncEnabled').checked = !!cfg.syncEnabled;
  el('databaseUrl').value = cfg.databaseUrl || '';

  // load publishers catalog (best-effort)
  let catalog = { publishers: [] };
  try{
    const p = await api('/api/publishers');
    if(p && p.ok && p.json && p.json.publishers) catalog = p.json;
  }catch(e){ /* ignore */ }

  renderPublishersTable(catalog.publishers || [], cfg.publishers || {});
  el('out').textContent = '설정 로드 성공';
}

async function save(){
  // collect publishers table values
  const rows = Array.from(document.querySelectorAll('.publisher-row'));
  const pubs = {};
  for(const row of rows){
    const id = row.dataset.pubId;
    const keyInput = row.querySelector('.pub-key');
    if(!id) continue;
    const val = keyInput ? keyInput.value.trim() : '';
    if(val) pubs[id] = val;
  }
  const payload = { syncEnabled: !!el('syncEnabled').checked, publishers: pubs, databaseUrl: el('databaseUrl').value || '' };
  const r = await api('/api/admin/config', { method:'POST', body: JSON.stringify(payload) });
  if(!r.ok){ el('out').textContent = `저장 실패: ${r.status} ${JSON.stringify(r.json||r.text)}`; return; }
  el('out').textContent = `저장 성공: ${JSON.stringify(r.json||r.text)}`;
}

function makePublisherRow(id, name, key){
  const div = document.createElement('div');
  div.className = 'publisher-row';
  div.dataset.pubId = id;
  div.style.display = 'flex'; div.style.alignItems = 'center'; div.style.gap = '8px'; div.style.marginBottom='6px';
  const label = document.createElement('div'); label.textContent = name || id; label.style.width='260px';
  const idEl = document.createElement('div'); idEl.textContent = id; idEl.style.display='none';
  const input = document.createElement('input'); input.type='text'; input.className='pub-key'; input.placeholder='API 키'; input.value = key || ''; input.style.flex='1';
  const btn = document.createElement('button'); btn.type='button'; btn.textContent='삭제'; btn.className='pub-delete';
  btn.addEventListener('click', ()=>{ try{ div.remove(); }catch(e){} });
  div.appendChild(label); div.appendChild(input); div.appendChild(btn);
  return div;
}

function renderPublishersTable(catalog, cfgPublishers){
  const container = el('publishersTable');
  container.innerHTML = '';
  const knownIds = new Set();
  for(const p of catalog){
    const id = p.id; knownIds.add(id);
    const name = p.shortName || p.name || id;
    const key = cfgPublishers && cfgPublishers[id] ? cfgPublishers[id] : '';
    container.appendChild(makePublisherRow(id, name, key));
  }
  // include any custom entries from cfgPublishers not in catalog
  for(const id of Object.keys(cfgPublishers||{})){
    if(knownIds.has(id)) continue;
    const name = id; const key = cfgPublishers[id];
    container.appendChild(makePublisherRow(id, name, key));
  }
}

document.addEventListener('DOMContentLoaded', ()=>{
  // add publisher button
  const addBtn = el('addPublisherBtn');
  if(addBtn){
    addBtn.addEventListener('click', ()=>{
      const id = (el('newPubId').value||'').trim();
      const name = (el('newPubName').value||'').trim() || id;
      const key = (el('newPubKey').value||'').trim();
      if(!id){ el('out').textContent = '출판사 id를 입력하세요.'; return; }
      const container = el('publishersTable');
      container.appendChild(makePublisherRow(id, name, key));
      el('newPubId').value=''; el('newPubName').value=''; el('newPubKey').value='';
    });
  }
});

async function migrate(){
  el('out').textContent = '마이그레이션 시작...';
  const r = await api('/api/admin/migrate', { method:'POST' });
  if(!r.ok) { el('out').textContent = `마이그레이션 실패: ${r.status} ${JSON.stringify(r.json||r.text)}`; return; }
  el('out').textContent = `마이그레이션 결과: ${JSON.stringify(r.json)}`;
}

document.addEventListener('DOMContentLoaded', ()=>{
  el('saveBtn').addEventListener('click', save);
  el('refreshBtn').addEventListener('click', refresh);
  el('migrateBtn').addEventListener('click', ()=>{ if(confirm('정말 파일을 DB로 마이그레이션 하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) migrate(); });
  refresh();
});
