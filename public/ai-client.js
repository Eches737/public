// ai-client.js — lightweight browser client exposing window.AIClient.summarizeText
(function(){
  'use strict';
  const API_BASE = "https://abc123.execute-api.ap-northeast-2.amazonaws.com";

  async function summarizeText(text) {
    // Try the real API first. If DNS/network error occurs (eg. placeholder domain),
    // fall back to a local/dev summary so UI can be tested without a working API.
    try {
      // Attach Authorization if Cognito token available
      const headers = { 'Content-Type': 'application/json' };
      try {
        const tok = sessionStorage.getItem('cognito_tokens');
        if (tok) {
          const t = JSON.parse(tok);
          if (t && t.id_token) headers['Authorization'] = `Bearer ${t.id_token}`;
        }
      } catch (e) { /* ignore */ }

      const res = await fetch(`${API_BASE}/ai/summarize`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text })
      });

      if (!res.ok) {
        // If server responds with an error status, throw to trigger fallback handling
        throw new Error('AI 요청 실패: ' + res.status + ' ' + res.statusText);
      }

      const data = await res.json();
      return data.summary;
    } catch (err) {
      // Likely DNS / network / CORS / auth error. Log and return a safe local fallback.
      try { console.warn('AI client fetch failed, returning local fallback summary:', err); } catch(e){}

      // Create a concise fallback summary (trim and add note)
      const snippet = (text || '').trim().replace(/\s+/g, ' ').slice(0, 480);
      const fallback = snippet
        ? `로컬 테스트 요약: ${snippet.length > 200 ? snippet.slice(0,200) + '…' : snippet}`
        : '로컬 테스트 요약: (요약할 텍스트가 비어 있습니다)';

      // Wait a tick to simulate async network latency so UI behaves naturally
      await new Promise((r) => setTimeout(r, 250));
      return fallback;
    }
  }

  window.AIClient = window.AIClient || {};
  window.AIClient.summarizeText = summarizeText;
})();
