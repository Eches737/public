#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")" && pwd)
echo "Deploying user-state SAM stack from $ROOT_DIR"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--stack-name NAME] [--external-bucket BUCKET] [--non-interactive]

Options:
  --stack-name NAME       Stack name to deploy (default: ref-paper-user-state)
  --external-bucket NAME  Use existing S3 bucket name instead of creating one
  --non-interactive       Deploy non-interactively (requires --stack-name)
  -h, --help              Show this help

Examples:
  # Interactive guided deploy
  ./deploy.sh

  # Non-interactive deploy with stack name
  ./deploy.sh --stack-name ref-paper-user-state --non-interactive

  # Use existing bucket non-interactively
  ./deploy.sh --stack-name ref-paper-user-state --external-bucket my-existing-bucket --non-interactive
EOF
}

STACK_NAME="ref-paper-user-state"
EXTERNAL_BUCKET=""
NON_INTERACTIVE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack-name)
      STACK_NAME="$2"; shift 2;;
    --external-bucket)
      EXTERNAL_BUCKET="$2"; shift 2;;
    --non-interactive)
      NON_INTERACTIVE=1; shift;;
    -h|--help)
      usage; exit 0;;
    *)
      echo "Unknown arg: $1"; usage; exit 1;;
  esac
done

cd "$ROOT_DIR"

echo "Installing npm dependencies (if missing)..."
if [ ! -d node_modules ]; then
  npm install || true
fi

echo "Building SAM..."
sam build --template-file template.yaml

if [ "$NON_INTERACTIVE" -eq 1 ]; then
  if [ -z "$STACK_NAME" ]; then
    echo "--stack-name is required for non-interactive deploy"; exit 1
  fi

  PARAM_OVERRIDES=""
  if [ -n "$EXTERNAL_BUCKET" ]; then
    PARAM_OVERRIDES="--parameter-overrides ExternalBucketName=${EXTERNAL_BUCKET}"
  fi

  echo "Deploying non-interactively: stack=$STACK_NAME external_bucket=${EXTERNAL_BUCKET}"
  sam deploy --stack-name "$STACK_NAME" $PARAM_OVERRIDES --capabilities CAPABILITY_IAM --no-confirm-changeset
else
  echo "Deploying interactively (guided). If you want non-interactive deploy, pass --non-interactive and --stack-name"
  sam deploy --guided
fi

echo "Done. After deployment, check Outputs for UserStateApiUrl and set it as API_BASE in src/api/userState.ts"
