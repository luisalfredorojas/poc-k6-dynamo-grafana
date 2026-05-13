#!/usr/bin/env bash
set -euo pipefail

ENDPOINT="${DYNAMODB_ENDPOINT:-http://dynamodb-local:8000}"

echo "Waiting for DynamoDB at ${ENDPOINT}..."
until aws dynamodb list-tables \
  --endpoint-url "$ENDPOINT" \
  --region "${AWS_REGION:-us-east-1}" \
  --no-cli-pager \
  > /dev/null 2>&1; do
  echo "  not ready, retrying in 2s..."
  sleep 2
done
echo "DynamoDB is ready."

create_table_if_not_exists() {
  local table_name="$1"
  local create_args="$2"

  if aws dynamodb describe-table \
    --endpoint-url "$ENDPOINT" \
    --region "${AWS_REGION:-us-east-1}" \
    --table-name "$table_name" \
    --no-cli-pager \
    > /dev/null 2>&1; then
    echo "Table ${table_name} already exists, skipping."
  else
    echo "Creating table ${table_name}..."
    eval "$create_args" | python3 -c "import sys,json; d=json.load(sys.stdin); print('Created:', d['TableDescription']['TableName'])"
  fi
}

create_table_if_not_exists "k6_test_runs" "aws dynamodb create-table \
  --endpoint-url '$ENDPOINT' \
  --region '${AWS_REGION:-us-east-1}' \
  --table-name k6_test_runs \
  --attribute-definitions AttributeName=run_id,AttributeType=S \
  --key-schema AttributeName=run_id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --no-cli-pager"

create_table_if_not_exists "k6_thresholds" "aws dynamodb create-table \
  --endpoint-url '$ENDPOINT' \
  --region '${AWS_REGION:-us-east-1}' \
  --table-name k6_thresholds \
  --attribute-definitions \
    AttributeName=run_id,AttributeType=S \
    AttributeName=metric,AttributeType=S \
  --key-schema \
    AttributeName=run_id,KeyType=HASH \
    AttributeName=metric,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --no-cli-pager"

echo "Initialization complete."
