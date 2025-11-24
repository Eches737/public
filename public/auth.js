// auth.js - PKCE helper + login flow for Cognito Hosted UI
(function(){
  const CLIENT_ID = window.__COGNITO_CLIENT_ID || null; // optional override
  const COGNITO_DOMAIN = window.__COGNITO_DOMAIN || null; // e.g. your-domain.auth.region.amazoncognito.com
  const REDIRECT_URI = window.__COGNITO_REDIRECT_URI || (window.location.origin + '/callback.html');

  function base64UrlEncode(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function sha256(str) {
    const enc = new TextEncoder();
    const data = enc.encode(str);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return base64UrlEncode(hash);
  }

  function randomString(length = 64) {
    const arr = new Uint8Array(length);
    crypto.getRandomValues(arr);
    // map to URL-safe chars
    return Array.from(arr).map(b => (b % 36).toString(36)).join('').slice(0, length);
  }

  async function startLogin() {
    const clientId = CLIENT_ID || document.body.getAttribute('data-cognito-client-id');
    const domain = COGNITO_DOMAIN || document.body.getAttribute('data-cognito-domain');
    const redirect = REDIRECT_URI;
    if (!clientId || !domain) {
      alert('Cognito client id or domain not configured');
      return;
    }

    const verifier = randomString(64);
    sessionStorage.setItem('pkce_verifier', verifier);
    const challenge = await sha256(verifier);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirect,
      scope: 'openid profile email',
      code_challenge_method: 'S256',
      code_challenge: challenge
    });

    const url = `https://${domain}/login?${params.toString()}`;
    window.location.href = url;
  }

  async function handleCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    if (!code) return;

    const verifier = sessionStorage.getItem('pkce_verifier');
    // Send code + verifier to backend for token exchange
    try {
      const resp = await fetch('/auth/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, code_verifier: verifier })
        });
        const j = await resp.json();
        if (resp.ok && j.ok) {
          // store tokens in sessionStorage/localStorage for frontend use
          try {
            const tokens = j.tokens || {};
            // tokens: { access_token, id_token, refresh_token, expires_in, token_type }
            sessionStorage.setItem('cognito_tokens', JSON.stringify(tokens));
          } catch (e) { console.warn('store tokens failed', e); }

          // successful - clear verifier and redirect
          sessionStorage.removeItem('pkce_verifier');
          window.location.href = '/';
        } else {
          console.error('Token exchange failed', j);
          document.body.innerText = 'Login failed: ' + (j.error || JSON.stringify(j));
        }
    } catch (e) {
      console.error('Callback exchange error', e);
      document.body.innerText = 'Login failed: ' + e.message;
    }
  }

  // expose functions
  window.CognitoAuth = {
    startLogin,
    handleCallback
  };

  // auto-wire login button if present
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('loginBtn');
    if (btn) btn.addEventListener('click', (e) => { e.preventDefault(); startLogin(); });

    // if on callback page, run handler
    if (window.location.pathname.endsWith('/callback.html')) {
      handleCallback();
    }
  });
})();
