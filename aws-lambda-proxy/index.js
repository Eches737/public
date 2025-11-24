const axios = require('axios');
const qs = require('querystring');

async function handleSearch(event) {
  const q = event.queryStringParameters?.q || '';
  const apiKey = process.env.EXTERNAL_API_KEY || '';
  const externalBase = process.env.EXTERNAL_API_URL || 'https://external-search.example.com/search';
  const url = `${externalBase}?q=${encodeURIComponent(q)}`;

  try {
    const resp = await axios.get(url, {
      headers: {
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
}

async function handleAuthCallback(event) {
  // Expects JSON body { code, code_verifier }
  try {
    const body = JSON.parse(event.body || '{}');
    const { code, code_verifier } = body;
    const COGNITO_DOMAIN = process.env.COGNITO_DOMAIN;
    const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
    const REDIRECT_URI = process.env.COGNITO_REDIRECT_URI;

    if (!COGNITO_DOMAIN || !CLIENT_ID || !REDIRECT_URI) {
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Cognito not configured' }), headers: { 'Access-Control-Allow-Origin': '*' } };
    }

    const tokenUrl = `https://${COGNITO_DOMAIN}/oauth2/token`;
    const payload = {
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier
    };

    const resp = await axios.post(tokenUrl, qs.stringify(payload), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    // Return tokens to client for storage
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ok: true, tokens: resp.data })
    };
  } catch (err) {
    console.error('Auth callback error', err?.response?.data || err.message || err);
    return {
      statusCode: err?.response?.status || 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: false, error: err?.message })
    };
  }
}

exports.handler = async (event) => {
  const path = event.path || event.requestContext?.http?.path || '/';
  const method = (event.httpMethod || event.requestContext?.http?.method || 'GET').toUpperCase();

  if (path.startsWith('/auth/callback') && method === 'POST') {
    return handleAuthCallback(event);
  }

  // default: search proxy if query param present
  return handleSearch(event);
};
