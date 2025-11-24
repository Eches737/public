#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")" && pwd)
echo "Deploying user-state SAM stack from $ROOT_DIR"

cd "$ROOT_DIR"

echo "Installing npm dependencies (if missing)..."
if [ ! -d node_modules ]; then
  npm install || true
fi

echo "Building SAM..."
sam build --template-file template.yaml

echo "Deploying (interactive). If you want non-interactive deploy, run 'sam deploy --stack-name <name> --capabilities CAPABILITY_IAM'"
sam deploy --guided

echo "Done. After deployment, check Outputs for UserStateApiUrl and set it as API_BASE in src/api/userState.ts"
