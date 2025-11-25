import { useEffect } from "react";

export default function AuthCallback() {
  useEffect(() => {
    // Placeholder: handle the authorization code returned by Cognito
    // Example: const code = new URLSearchParams(window.location.search).get('code')
    // Exchange the code for tokens via your backend, or use Amplify/Auth to handle it.
    const code = new URLSearchParams(window.location.search).get('code');
    console.log('Auth callback code:', code);
  }, []);

  return <p>로그인 응답 처리중...</p>;
}
