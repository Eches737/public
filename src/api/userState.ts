const API_BASE = "https://crumgr8vbi.execute-api.ap-northeast-2.amazonaws.com"; // 네 API URL
const USER_SUB = "test-user-1"; // 지금은 테스트용, 나중에 Cognito sub로 교체

export async function getUserState() {
  const res = await fetch(`${API_BASE}/user/state?userSub=${USER_SUB}`);
  if (!res.ok) throw new Error("getUserState failed");
  return res.json() as Promise<{ sidebar: any; papers: any }>;
}

export async function saveUserState(sidebar: any, papers: any) {
  const res = await fetch(`${API_BASE}/user/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userSub: USER_SUB, sidebar, papers }),
  });
  if (!res.ok) throw new Error("saveUserState failed");
  return res.json();
}
