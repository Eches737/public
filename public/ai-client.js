// ai-client.js — lightweight browser client exposing window.AIClient.summarizeText
(function(){
  'use strict';
  const API_BASE = "https://abc123.execute-api.ap-northeast-2.amazonaws.com";

  async function summarizeText(text) {
    const res = await fetch(`${API_BASE}/ai/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!res.ok) throw new Error('AI 요청 실패');
    const data = await res.json();
    return data.summary;
  }

  window.AIClient = window.AIClient || {};
  window.AIClient.summarizeText = summarizeText;
})();
