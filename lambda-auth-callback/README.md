Lambda auth callback package

Contents

- index.mjs — minimal Lambda handler (ES module). Exported function `handler` is the entrypoint.
- package.json — minimal metadata (no dependencies).

Quick usage

1. Create zip locally:

```bash
cd lambda-auth-callback
zip -r function.zip .
```

2. Create Lambda (one-time):

```bash
aws lambda create-function \
  --function-name ref-paper-auth-callback \
  --runtime nodejs20.x \
  --role arn:aws:iam::<ACCOUNT_ID>:role/<lambda-exec-role> \
  --handler index.handler \
  --zip-file fileb://function.zip
```

3. Update code (CI or local):

```bash
aws lambda update-function-code \
  --function-name ref-paper-auth-callback \
  --zip-file fileb://function.zip
```

Notes
- We use `type: "module"` so this package uses ESM (`.mjs`). The Lambda handler export is `export async function handler(...)` and the AWS handler string remains `index.handler`.
- If your auth callback needs extra dependencies, add them to `package.json` and run `npm ci` before zipping so node_modules are included.
