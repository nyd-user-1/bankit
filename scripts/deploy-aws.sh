#!/usr/bin/env bash
# Deploy Playground to AWS: both Lambdas (api + websocket) and the static site on Amplify.
#   scripts/deploy-aws.sh            → everything
#   scripts/deploy-aws.sh lambdas    → only the Lambdas
#   scripts/deploy-aws.sh site       → only the Amplify static site
# One-time setup already done (see CLAUDE.md "Deploy"): DynamoDB table bankit-ws, IAM role
# bankit-lambda, the Function URL on bankit-api, the WebSocket API, the Amplify app.
set -euo pipefail
cd "$(dirname "$0")/.."
REGION=us-east-1
ACCOUNT=638175140432
ROLE=arn:aws:iam::$ACCOUNT:role/bankit-lambda
AMPLIFY_APP=${AMPLIFY_APP:-$(cat aws/amplify-app-id 2>/dev/null || true)}
WHAT=${1:-all}
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT

envval() { grep "^$1=" .env.local | head -1 | cut -d= -f2- | sed 's/^"//; s/"$//'; }

deploy_lambdas() {
  echo "• packaging lambdas"
  mkdir -p "$BUILD/pkg"
  cp -R api "$BUILD/pkg/api"
  cp aws/api-handler.js aws/ws-handler.js aws/builder-handler.js package.json package-lock.json "$BUILD/pkg/"
  mkdir -p "$BUILD/pkg/aws" && cp aws/game-skeleton.html aws/game-playbook.md "$BUILD/pkg/aws/"   # the builder reads these
  (cd "$BUILD/pkg" && npm ci --omit=dev --silent && rm -f package.json package-lock.json && zip -qr ../lambda.zip .)
  local vars
  vars="Variables={BANKIT_DB_CLUSTER_ARN=$(envval BANKIT_DB_CLUSTER_ARN),BANKIT_DB_SECRET_ARN=$(envval BANKIT_DB_SECRET_ARN),BANKIT_DB_NAME=$(envval BANKIT_DB_NAME),WS_TABLE=bankit-ws,BUILDER_FUNCTION=bankit-builder}"
  # name:handler:timeout:memory — the builder waits on one long model call
  for fn in bankit-api:api-handler.handler:60:512 bankit-ws:ws-handler.handler:60:512 bankit-builder:builder-handler.handler:900:1024; do
    local name handler timeout mem; IFS=: read -r name handler timeout mem <<<"$fn"
    if aws lambda get-function --function-name "$name" --region $REGION >/dev/null 2>&1; then
      echo "• updating $name"
      aws lambda update-function-code --function-name "$name" --zip-file "fileb://$BUILD/lambda.zip" --region $REGION --query LastModified --output text >/dev/null
      aws lambda wait function-updated --function-name "$name" --region $REGION
      aws lambda update-function-configuration --function-name "$name" --environment "$vars" --timeout "$timeout" --memory-size "$mem" --region $REGION --query LastModified --output text >/dev/null
      aws lambda wait function-updated --function-name "$name" --region $REGION
    else
      echo "• creating $name"
      aws lambda create-function --function-name "$name" --runtime nodejs22.x --handler "$handler" --role $ROLE \
        --timeout "$timeout" --memory-size "$mem" --zip-file "fileb://$BUILD/lambda.zip" --environment "$vars" --region $REGION \
        --query FunctionArn --output text >/dev/null
      aws lambda wait function-active --function-name "$name" --region $REGION
    fi
  done
}

deploy_site() {
  [ -n "$AMPLIFY_APP" ] || { echo "no Amplify app id (aws/amplify-app-id)"; exit 1; }
  echo "• packaging site"
  mkdir -p "$BUILD/site"
  cp ./*.html shell.css shell.js icon.svg icon-maskable.svg manifest.webmanifest "$BUILD/site/"
  (cd "$BUILD/site" && zip -qr ../site.zip .)
  local dep job url
  dep=$(aws amplify create-deployment --app-id "$AMPLIFY_APP" --branch-name main --region $REGION --output json)
  job=$(echo "$dep" | python3 -c 'import sys,json; print(json.load(sys.stdin)["jobId"])')
  url=$(echo "$dep" | python3 -c 'import sys,json; print(json.load(sys.stdin)["zipUploadUrl"])')
  curl -sf -X PUT -T "$BUILD/site.zip" "$url" >/dev/null
  aws amplify start-deployment --app-id "$AMPLIFY_APP" --branch-name main --job-id "$job" --region $REGION --query jobSummary.status --output text
  for _ in $(seq 60); do
    st=$(aws amplify get-job --app-id "$AMPLIFY_APP" --branch-name main --job-id "$job" --region $REGION --query job.summary.status --output text)
    [ "$st" = SUCCEED ] && { echo "• site live: https://main.$AMPLIFY_APP.amplifyapp.com"; return; }
    [ "$st" = FAILED ] && { echo "• site deploy FAILED"; exit 1; }
    sleep 3
  done
  echo "• still deploying — check the Amplify console"
}

case $WHAT in
  lambdas) deploy_lambdas ;;
  site) deploy_site ;;
  all) deploy_lambdas; deploy_site ;;
esac
