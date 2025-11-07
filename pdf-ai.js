(function(){
  'use strict';

  // AI utilities that operate against the currently loaded PDF document.
  // Depends on window.PDFViewer.getPdfDoc() being provided by pdf-viewer.js

  function getPdfDoc() {
    try {
      return window.PDFViewer && typeof window.PDFViewer.getPdfDoc === 'function' ? window.PDFViewer.getPdfDoc() : null;
    } catch (e) {
      console.warn('pdf-ai: cannot access PDFViewer.getPdfDoc', e);
      return null;
    }
  }

  async function extractFullTextFromPdf(){
    const pdfDoc = getPdfDoc();
    if(!pdfDoc) return '';
    const parts = [];
    for(let i=1;i<=pdfDoc.numPages;i++){
      try{
        const page = await pdfDoc.getPage(i);
        const content = await page.getTextContent();
        const strings = content.items.map(it=>it.str).join(' ');
        parts.push(strings);
      }catch(e){ console.warn('pdf-ai: extract page failed', i, e); }
      // avoid blocking UI too long
      if(i%5===0) await new Promise(r=>setTimeout(r,30));
    }
    return parts.join('\n\n');
  }

  async function doSummarize(){
    const statusEl = document.getElementById('aiStatus');
    const outEl = document.getElementById('aiResult');
    if(!statusEl || !outEl) return;
    statusEl.textContent = '텍스트 추출 중...'; outEl.textContent='';
    const text = await extractFullTextFromPdf();
    if(!text){ statusEl.textContent = '열려있는 문서의 텍스트를 가져올 수 없습니다.'; return; }
    statusEl.textContent = '요약 생성 중...';
    try{
      const r = await fetch('/api/ai/summarize', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text, title: document.title }) });
      const j = await r.json();
      if(!j.ok){ statusEl.textContent = '요약 실패: ' + (j.error||'unknown'); outEl.textContent = JSON.stringify(j); return; }
      statusEl.textContent = '요약 완료';
      const escapeHtml = window.escapeHtml || ((s)=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'));
      const html = `
        ${j.title?`<h3 style="margin:0 0 8px 0">${escapeHtml(j.title)}</h3>`:''}
        <p>${escapeHtml(j.summary || '')}</p>
        ${j.bullets && j.bullets.length?'<h4>키워드</h4><ul>'+j.bullets.map(b=>`<li>${escapeHtml(b)}</li>`).join('')+'</ul>':''}
      `;
      outEl.innerHTML = html;
    }catch(e){ console.error('pdf-ai: summarize failed', e); statusEl.textContent = '요약 실패: ' + e.message; outEl.textContent = String(e); }
  }

  // lightweight extraction action for debugging
  async function doExtract(){
    const statusEl = document.getElementById('aiStatus');
    const outEl = document.getElementById('aiResult');
    if(!statusEl || !outEl) return;
    statusEl.textContent = '추출 중...'; outEl.textContent='';
    const text = await extractFullTextFromPdf();
    statusEl.textContent = '추출 완료';
    if(!text) { outEl.textContent = ''; return; }
    outEl.textContent = text.slice(0, 2000) + (text.length>2000? '\n... (truncated)':'');
  }

  // wire AI buttons
  try{
    document.addEventListener('DOMContentLoaded', ()=>{
      const sBtn = document.getElementById('summarizeBtn');
      const eBtn = document.getElementById('extractBtn');
      if(sBtn) sBtn.addEventListener('click', doSummarize);
      if(eBtn) eBtn.addEventListener('click', doExtract);
      // AI sidebar toggle
      const aiToggle = document.getElementById('aiToggle');
      const aiSidebar = document.getElementById('aiSidebar');
      if (aiToggle && aiSidebar) {
        aiToggle.addEventListener('click', (ev) => {
          ev.preventDefault();
          const collapsed = aiSidebar.classList.toggle('ai-collapsed');
          document.body.classList.toggle('ai-open', !collapsed);
          aiToggle.setAttribute('aria-expanded', String(!collapsed));
          aiToggle.textContent = collapsed ? '◀' : '▶';
          // update handle accessibility
          const aiHandle = document.getElementById('aiHandle');
          if (aiHandle) aiHandle.setAttribute('aria-hidden', String(!collapsed));
        });
        // initialize state
        const initialCollapsed = aiSidebar.classList.contains('ai-collapsed');
        aiToggle.textContent = initialCollapsed ? '◀' : '▶';
        const aiHandleInit = document.getElementById('aiHandle');
        if (aiHandleInit) aiHandleInit.setAttribute('aria-hidden', String(!initialCollapsed));
      }
      // handle button (visible when sidebar is collapsed)
      const aiHandle = document.getElementById('aiHandle');
      if (aiHandle) {
        aiHandle.addEventListener('click', (ev) => {
          ev.preventDefault();
          const collapsed = aiSidebar.classList.toggle('ai-collapsed');
          document.body.classList.toggle('ai-open', !collapsed);
          if (aiToggle) aiToggle.setAttribute('aria-expanded', String(!collapsed));
          if (aiToggle) aiToggle.textContent = collapsed ? '◀' : '▶';
          // update handle aria
          aiHandle.setAttribute('aria-hidden', String(!collapsed));
        });
      }
    });
  }catch(e){ console.warn('pdf-ai: AI button wiring failed', e); }

})();
