import { Auth } from "aws-amplify";

const API_BASE = "https://crumgr8vbi.execute-api.ap-northeast-2.amazonaws.com";

async function authFetch(url: string, options: RequestInit = {}) {
  const session = await Auth.currentSession();
  const token = session.getIdToken().getJwtToken();

  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: token,
      "Content-Type": "application/json",
    },
  });
}

export async function getUserState() {
  const res = await authFetch(`${API_BASE}/user/state`, { method: "GET" });
  if (!res.ok) throw new Error("getUserState failed");
  return res.json() as Promise<{ sidebar: any; papers: any }>;
}

export async function saveUserState(sidebar: any, papers: any) {
  const res = await authFetch(`${API_BASE}/user/state`, {
    method: "POST",
    body: JSON.stringify({ sidebar, papers }),
  });
  if (!res.ok) throw new Error("saveUserState failed");
  return res.json();
}
