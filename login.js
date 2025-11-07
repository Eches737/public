// Simple client-side login for development/demo purposes.
// Stores a basic token in localStorage and redirects to index.html on success.
(function(){
  const form = document.getElementById('loginForm');
  const errEl = document.getElementById('error');
  const guestBtn = document.getElementById('guestBtn');

  function showError(msg){ errEl.textContent = msg; errEl.style.display = 'block'; }
  function clearError(){ errEl.textContent = ''; errEl.style.display = 'none'; }

  function setAuth(username){
    try{
      const token = btoa(`${username}:${Date.now()}`);
      localStorage.setItem('paperscout_auth_token', token);
      localStorage.setItem('paperscout_auth_user', username);
    }catch(e){ /* ignore */ }
  }

  form.addEventListener('submit', function(e){
    e.preventDefault(); clearError();
    const u = (document.getElementById('username').value || '').trim();
    const p = (document.getElementById('password').value || '').trim();
    if(!u || !p){ showError('사용자 이름과 비밀번호를 모두 입력하세요.'); return; }

    // Try backend authentication first (POST /api/auth/login). If backend
    // is unreachable, fall back to local mock login for development.
    (async function(){
      try {
        const res = await fetch('http://localhost:3001/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: u, password: p })
        });
        if (res.ok) {
          const data = await res.json().catch(()=>null);
          if (data && data.token) {
            localStorage.setItem('paperscout_auth_token', data.token);
            localStorage.setItem('paperscout_auth_user', data.user || u);
            window.location.replace('index.html');
            return;
          }
          // unexpected success payload
          setAuth(u);
          window.location.replace('index.html');
          return;
        }
        if (res.status === 401) {
          showError('인증 실패: 사용자 이름이나 비밀번호가 올바르지 않습니다.');
          return;
        }
        // other server errors -> fallback to mock after warning
        console.warn('Login server error', res.status);
      } catch (err) {
        console.warn('Login backend unreachable, falling back to mock login', err);
        // fallback to mock
        setAuth(u);
        window.location.replace('index.html');
      }
    })();
  });

  guestBtn.addEventListener('click', function(){
    // set a guest token and continue
    setAuth('guest');
    window.location.replace('index.html');
  });

  // If already authenticated, go to index
  try{
    if(localStorage.getItem('paperscout_auth_token')){
      // small delay to allow developer to see page
      setTimeout(()=>{ window.location.replace('index.html'); }, 100);
    }
  }catch(e){}
})();
