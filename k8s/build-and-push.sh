#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# Construye la imagen del api-gateway y la sube a Amazon ECR.
# Uso:  AWS_ACCOUNT_ID=123456789012 AWS_REGION=us-east-1 ./build-and-push.sh
# ─────────────────────────────────────────────────────────────

: "${AWS_ACCOUNT_ID:?Define AWS_ACCOUNT_ID (ej. 123456789012)}"
AWS_REGION="${AWS_REGION:-us-east-1}"
REPO_NAME="${REPO_NAME:-k6-api-gateway}"
TAG="${TAG:-latest}"

ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${REPO_NAME}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATEWAY_DIR="${SCRIPT_DIR}/../api-gateway"

echo "==> Asegurando que el repo ECR exista..."
aws ecr describe-repositories --repository-names "$REPO_NAME" --region "$AWS_REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$REPO_NAME" --region "$AWS_REGION" >/dev/null

echo "==> Login a ECR..."
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo "==> Build (linux/amd64 para nodos EKS)..."
docker build --platform linux/amd64 -t "${REPO_NAME}:${TAG}" "$GATEWAY_DIR"

echo "==> Tag + push..."
docker tag "${REPO_NAME}:${TAG}" "${ECR_URI}:${TAG}"
docker push "${ECR_URI}:${TAG}"

echo ""
echo "✓ Imagen disponible en: ${ECR_URI}:${TAG}"
echo "  Usa ese valor en el campo 'image:' de k8s/api-gateway.yaml"
