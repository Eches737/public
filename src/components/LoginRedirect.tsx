import { useEffect } from "react";

const COGNITO_DOMAIN = import.meta.env.VITE_COGNITO_DOMAIN || "https://ap-northeast-2xhcjyrxcu.auth.ap-northeast-2.amazoncognito.com";
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID || "당신의_ref-paper-web_ClientID";
const REDIRECT_URI = import.meta.env.VITE_COGNITO_REDIRECT_URI || "https://ref-paper.com/auth/callback";

export default function LoginRedirect() {
  useEffect(() => {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      scope: "openid email",
      redirect_uri: REDIRECT_URI,
    });

    window.location.href = `${COGNITO_DOMAIN}/login?${params.toString()}`;
  }, []);

  return <p>로그인 페이지로 이동 중입니다...</p>;
}
