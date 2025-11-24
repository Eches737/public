import { useEffect, useState } from "react";
import './App.css';
import { getUserState, saveUserState } from "./api/userState";

const USER_SUB = "test-user-1";

function App() {
  const [sidebar, setSidebar] = useState<any>({ items: [] });

  useEffect(() => {
    getUserState(USER_SUB)
      .then((data) => setSidebar(data.sidebar))
      .catch((e) => console.error(e));
  }, []);

  const handleAddItem = async () => {
    const newSidebar = {
      ...sidebar,
      items: [...(sidebar.items || []), { id: Date.now(), label: "새 항목" }]
    };
    setSidebar(newSidebar);

    try {
      await saveUserState(USER_SUB, newSidebar, { items: [] });
    } catch (e) {
      alert("저장 실패");
    }
  };

  return (
    <div style={{ padding: "2rem" }}>
      <h1>Ref Paper – User State Test</h1>
      <button onClick={handleAddItem}>사이드바 항목 추가 + 저장</button>

      <pre style={{ marginTop: "1rem" }}>
        {JSON.stringify(sidebar, null, 2)}
      </pre>
    </div>
  );
}

export default App;
