// pdf-ai.js — UI glue for PDF viewer AI sidebar (fallbacks to window.AIClient when available)
(function(){
  'use strict';

  function log(){ try{ console.log.apply(console, arguments); }catch(e){} }

  async function callSummarize(text){
    if (window.AIClient && typeof window.AIClient.summarizeText === 'function'){
      return window.AIClient.summarizeText(text);
    }
    // fallback (same endpoint)
    const API_BASE = "https://abc123.execute-api.ap-northeast-2.amazonaws.com";
    const res = await fetch(`${API_BASE}/ai/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!res.ok) throw new Error('AI 요청 실패');
    const data = await res.json();
    return data.summary;
  }

  // ensure sidebar textarea exists
  const aiSidebarBody = document.querySelector('#aiSidebar .sidebar__body');
  let textarea = document.getElementById('aiInput');
  if (aiSidebarBody && !textarea) {
    textarea = document.createElement('textarea');
    textarea.id = 'aiInput';
    textarea.placeholder = '논문 텍스트 일부를 붙여넣고 요약하세요.';
    textarea.style.width = '100%';
    textarea.style.height = '100px';
    textarea.style.marginBottom = '8px';
    const modelSelect = document.getElementById('aiModel');
    if (modelSelect && modelSelect.parentNode) modelSelect.parentNode.parentNode.insertBefore(textarea, modelSelect.parentNode.nextSibling);
    else aiSidebarBody.insertBefore(textarea, aiSidebarBody.firstChild);
  }

  const summarizeBtn = document.getElementById('summarizeBtn');
  const aiResult = document.getElementById('aiResult');
  const aiStatus = document.getElementById('aiStatus');

  if (summarizeBtn) {
    summarizeBtn.addEventListener('click', async function(){
      const text = (textarea && textarea.value) ? textarea.value.trim() : '';
      if (!text) {
        if (aiStatus) aiStatus.textContent = '요약할 텍스트를 입력하세요.';
        return;
      }
      if (aiStatus) aiStatus.textContent = '요약 중...';
      summarizeBtn.disabled = true;
      if (aiResult) aiResult.textContent = '';
      try {
        const summary = await callSummarize(text);
        if (aiResult) aiResult.textContent = summary;
        if (aiStatus) aiStatus.textContent = '요약 완료';
      } catch (err) {
        log('AI 요약 실패', err);
        if (aiStatus) aiStatus.textContent = 'AI 요약 중 오류 발생';
        alert('AI 요약 요청 실패: ' + (err && err.message));
      } finally {
        summarizeBtn.disabled = false;
      }
    });
  }

})();
