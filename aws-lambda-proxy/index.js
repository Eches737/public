const axios = require('axios');

exports.handler = async (event) => {
  const q = event.queryStringParameters?.q || '';
  const apiKey = process.env.EXTERNAL_API_KEY || '';
  const externalBase = process.env.EXTERNAL_API_URL || 'https://external-search.example.com/search';
  const url = `${externalBase}?q=${encodeURIComponent(q)}`;

  try {
    const resp = await axios.get(url, {
      headers: {
        // 외부 API 인증 방식에 맞게 수정하세요 (예: Authorization, x-api-key 등)
        'Authorization': apiKey ? `Bearer ${apiKey}` : undefined
      },
      timeout: 8000
    });

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(resp.data)
    };
  } catch (err) {
    console.error('External API error:', err?.response?.data || err.message || err);
    return {
      statusCode: err?.response?.status || 502,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Failed to fetch external API', detail: err?.message })
    };
  }
};
