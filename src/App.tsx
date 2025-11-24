import { useEffect, useState } from "react";
import { getUserState, saveUserState } from "./api/userState";
import { getCurrentUser, signInWithRedirect, signOut as amplifySignOut } from '@aws-amplify/auth';


function App() {
  const [sidebar, setSidebar] = useState<any>({ items: [] });

  // 로그인 버튼 핸들러: Amplify Auth로 Hosted UI로 이동
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  const handleLogin = async () => {
    try {
      await signInWithRedirect();
    } catch (e) {
      console.error('login error', e);
    }
  };

  const handleLogout = async () => {
    try {
      await amplifySignOut();
      setIsAuthenticated(false);
    } catch (e) {
      console.error('logout error', e);
    }
  };

  useEffect(() => {
    // check auth state on mount
    getCurrentUser()
      .then(() => setIsAuthenticated(true))
      .catch(() => setIsAuthenticated(false));
  }, []);

  // 처음 로딩할 때 S3에서 사용자 상태 읽어오기
  useEffect(() => {
    getUserState()
      .then((data) => setSidebar(data.sidebar))
      .catch((e) => {
        console.error(e);
      });
  }, []);

  const handleAdd = async () => {
    const updated = {
      ...sidebar,
      items: [...(sidebar.items || []), { id: Date.now(), label: "새 항목" }],
    };

    setSidebar(updated);

    try {
      await saveUserState(updated, { items: [] });
    } catch (e) {
      alert("저장 실패");
    }
  };

  return (
    <div style={{ padding: "2rem" }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>Ref Paper – 사용자 상태 테스트</h1>
        <div>
          {isAuthenticated ? (
            <button onClick={handleLogout} style={{ marginRight: 8 }}>로그아웃</button>
          ) : (
            <button onClick={handleLogin} style={{ marginRight: 8 }}>로그인</button>
          )}
          <button onClick={handleAdd}>사이드바 항목 추가 + 저장</button>
        </div>
      </div>

      <pre style={{ marginTop: "1rem" }}>
        {JSON.stringify(sidebar, null, 2)}
      </pre>
    </div>
  );
}

export default App;
