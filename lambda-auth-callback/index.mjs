// Minimal Lambda auth-callback handler (ES module)
// This file is intentionally simple — adapt the logic to your auth flow.

export async function handler(event) {
  console.log('auth-callback invoked');
  try {
    // event will contain request information depending on how Lambda is invoked
    // (API Gateway v1/v2, Lambda URL, ALB). Inspect `event` during testing.
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: `<!doctype html><html><head><meta charset="utf-8"><title>Auth Callback</title></head><body><h1>Auth callback received</h1><pre>${JSON.stringify(event, null, 2)}</pre></body></html>`
    };
  } catch (err) {
    console.error('handler error', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: String(err) })
    };
  }
}
