import { Amplify } from "aws-amplify";

// Amplify v6 types are stricter; cast to `any` here because this file contains
// placeholders that will be replaced with real Cognito values by the developer.
Amplify.configure({
  Auth: {
    region: "ap-northeast-2",
    userPoolId: "ap-northeast-2_xxxxxxxx", // 실제 User Pool ID로 교체
    userPoolWebClientId: "APP_CLIENT_ID", // 실제 App client ID로 교체
    oauth: {
      domain: "ref-paper-auth.auth.ap-northeast-2.amazoncognito.com",
      scope: ["openid", "email", "profile"],
      redirectSignIn: "https://ref-paper.com/",
      redirectSignOut: "https://ref-paper.com/",
      responseType: "code",
    },
  },
} as any);
