# User-State Lambda — SAM 배포 안내

이 디렉터리에는 사용자별 사이드바 상태를 S3에 저장/조회하는 Lambda와 SAM 템플릿이 들어 있습니다.

파일
- `index.js` — Lambda 핸들러 (GET/POST `/user/state`).
- `package.json` — Lambda 의존성(@aws-sdk/client-s3).
- `template.yaml` — SAM 템플릿 (S3 버킷 + Lambda + API Gateway).
- `run-local-test.js` — LOCAL_S3=1 모드로 로컬에서 POST→GET을 검증하는 스크립트.
- `deploy.sh` — (편의) SAM 빌드/배포 스크립트.

사전 준비
- AWS CLI가 설치되어 있고, `aws configure`로 자격증명과 기본 리전을 설정해야 합니다.
- SAM CLI가 설치되어 있어야 합니다 (https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html).

기본 배포 (권장: 첫 배포는 `--guided`를 사용)

1. 의존성 설치 (옵션 — 로컬에서 패키지 설치 필요 시)

```bash
cd aws/user-state
npm install
```

2. 빌드

```bash
sam build --template-file template.yaml
```

3. 배포 (처음은 guided 권장)

```bash
sam deploy --guided
```

배포 과정에서 스택 이름(stack name), 리전(region), 권한(CAPABILITY_IAM) 등을 물어봅니다.

버킷 사용 옵션
- 템플릿은 기본적으로 스택 이름을 기반으로 새 S3 버킷을 생성합니다 (버킷 이름: `${StackName}-user-state-bucket`).
- 이미 존재하는 버킷을 사용하려면 `ExternalBucketName` 파라미터에 버킷 이름을 지정해 배포하세요. 그러면 SAM은 새 버킷을 생성하지 않고 제공한 버킷을 사용합니다.

예: non-interactive로 기존 버킷 `my-existing-bucket`을 사용해 배포하려면:

```bash
sam deploy --stack-name ref-paper-user-state --parameter-overrides ExternalBucketName=my-existing-bucket --capabilities CAPABILITY_IAM --no-confirm-changeset
```


비대화형 배포 예 (사전 값 설정 시)

```bash
sam deploy --stack-name ref-paper-user-state --capabilities CAPABILITY_IAM --no-confirm-changeset --no-fail-on-empty-changeset
```

배포 후
- 출력(Outputs)에서 API URL을 확인하세요. README의 `UserStateApiUrl` 출력 값이 `/user/state` 엔드포인트 전체 URL을 제공합니다.
- 해당 URL을 `src/api/userState.ts`의 `API_BASE`로 설정하면 프론트엔드가 실제로 S3에 읽기/쓰기를 하게 됩니다.

로컬 테스트

로컬(in-memory) 테스트는 `LOCAL_S3=1` 환경변수로 실행하면 됩니다 (AWS SDK 설치 불필요):

```bash
LOCAL_S3=1 node run-local-test.js
```

보안 & 권한
- 프로덕션에서는 S3 버킷 이름을 고정하고 Lambda에게 최소 권한만 부여하세요.
- 또한 API Gateway 앞에 Cognito 인증을 추가해 인증된 사용자만 자신의 리소스에 접근하도록 하세요.

문제가 발생하면 이 저장소의 커밋 로그와 `sam logs -n UserStateFunction`(배포 후)을 확인해 주세요.
