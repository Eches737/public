const API_BASE = "https://abc123.execute-api.ap-northeast-2.amazonaws.com"; // 실제 URL로 교체

// 나중에는 Cognito에서 받은 userSub를 넣고, 지금은 테스트용으로 하드코딩해도 됨
const TEST_USER_SUB = "test-user-1";

export async function getUserState(userSub: string = TEST_USER_SUB) {
  const res = await fetch(
    `${API_BASE}/user/state?userSub=${encodeURIComponent(userSub)}`,
    {
      method: "GET"
    }
  );

  if (!res.ok) {
    throw new Error("getUserState failed");
  }

  return res.json() as Promise<{
    sidebar: any;
    papers: any;
  }>;
}

export async function saveUserState(
  userSub: string,
  sidebar: any,
  papers: any
) {
  const res = await fetch(`${API_BASE}/user/state`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ userSub, sidebar, papers })
  });

  if (!res.ok) {
    throw new Error("saveUserState failed");
  }

  return res.json();
}
