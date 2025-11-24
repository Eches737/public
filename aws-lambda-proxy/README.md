# aws-lambda-proxy — Deploying the proxy Lambda

This directory contains the proxy Lambda code (`index.js`) which previously handled external API proxying and now also routes `/user/state` to a local handler when present.

Automatic deploy via GitHub Actions
- A workflow `.github/workflows/deploy-proxy-lambda.yml` is included. It will run on pushes to `main` that change files under `aws-lambda-proxy/**`.

Before using the workflow, set the following repository secrets in GitHub settings:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION` (e.g. `ap-northeast-2`)
- `LAMBDA_FUNCTION_NAME` — the name (or ARN) of the existing Lambda function to update

Once secrets are set, push to `main` (or open a PR and merge). The workflow will zip the `aws-lambda-proxy` folder and call `aws lambda update-function-code` to update the function.

Manual deploy (local)
If you prefer to update the Lambda manually from your machine:

```bash
cd aws-lambda-proxy
zip -r ../proxy-deploy.zip . -x "node_modules/aws-sdk/**"
aws lambda update-function-code --function-name <YOUR_LAMBDA_NAME> --zip-file fileb://../proxy-deploy.zip --region <YOUR_REGION>
```

Notes
- The workflow and manual commands assume the Lambda uses the contents of this folder as its handler root. If your Lambda was created from a different artifact or has additional layers, adapt accordingly.
- For zero-downtime and safer deploys consider publishing a new version and updating aliases.
# AWS Lambda Proxy (외부 검색 API 연동 예제)

이 폴더는 외부 검색 API를 Lambda 함수로 프록시하는 예제입니다. API 키는 서버(또는 Secrets Manager)에 보관하고, 프론트엔드는 이 Lambda 엔드포인트를 호출합니다.

빠른 시작

1. 로컬에서 의존성 설치

```powershell
cd aws-lambda-proxy
npm install
```

2. (옵션) 로컬 테스트
- 간단히 `node index.js`로는 실행되지 않음(핸들러이므로). 로컬에서 테스트하려면 작은 Express 래퍼를 만들거나 AWS SAM을 사용하세요.

3. 배포 (AWS SAM 사용 예)

```powershell
# 1) 빌드
sam build --template-file template.yaml

# 2) 패키지 및 배포 (또는 sam deploy --guided)
sam deploy --guided
```

배포 후 API Gateway의 엔드포인트 예: `https://{api-id}.execute-api.{region}.amazonaws.com/Prod/search?q=검색어`

환경변수 및 시크릿
- 민감한 `EXTERNAL_API_KEY`는 Secrets Manager에 저장하고 Lambda가 읽도록 권한을 설정하세요.

프론트엔드 호출 예

```js
fetch('https://api.example.com/search?q=cnt')
  .then(r => r.json())
  .then(data => console.log(data))
  .catch(err => console.error(err));
```

CORS
- 이 예제는 모든 출처(`*`)에 대해 `Access-Control-Allow-Origin`을 허용합니다. 운영 환경에서는 도메인을 제한하세요.

참고
- 외부 API의 인증/요청 형식을 반드시 확인하고, `index.js`의 헤더 설정을 외부 API에 맞게 수정하세요.
