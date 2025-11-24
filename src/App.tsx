import { useEffect, useState } from "react";
import { getUserState, saveUserState } from "./api/userState";

function App() {
  const [sidebar, setSidebar] = useState<any>({ items: [] });

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
      <h1>Ref Paper – 사용자 상태 테스트</h1>
      <button onClick={handleAdd}>사이드바 항목 추가 + 저장</button>

      <pre style={{ marginTop: "1rem" }}>
        {JSON.stringify(sidebar, null, 2)}
      </pre>
    </div>
  );
}

export default App;
