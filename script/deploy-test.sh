#!/usr/bin/env bash
# MyCut test 环境一键部署脚本（Git Bash / Linux 均可）。
# 固化上线 SOP：镜像构建推送 -> 集群准备 -> 迁移 -> 发布 -> 验证。
#
# 用法：
#   ./script/deploy-test.sh --build            # 全流程：构建镜像 + 推送 + 部署
#   ./script/deploy-test.sh                    # 仅部署（镜像已由 CI 推好）
#   ./script/deploy-test.sh --build --skip-migrate   # 跳过迁移（无 schema 变更时）
#
# 依赖的环境变量（可放到本机 env 或 CI 变量，勿写死进文件）：
#   REG_TOKEN   GitLab Personal Access Token（需 write_repository + read_registry）
#   KUBECONFIG  集群访问配置（或已 merge 的 context）
set -euo pipefail

cd "$(dirname "$0")/.."

REGISTRY_HOST="gitlab.sunwin-sh.com"
IMAGE="${REGISTRY_HOST}/development/mycut/web"
NAMESPACE="mycut-test"
SITE_URL="https://test-mycut.sunwin-sh.com"

BUILD=false
SKIP_MIGRATE=false
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=true ;;
    --skip-migrate) SKIP_MIGRATE=true ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

# 不可变镜像 tag：日期 + git 短 sha，杜绝 test-latest 浮动 tag 的回滚困境
SHORT_SHA="$(git rev-parse --short HEAD)"
TAG="test-$(date +%Y%m%d).${SHORT_SHA}"
echo "==> 镜像: ${IMAGE}:${TAG}"

# ---------------------------------------------------------------- 构建推送
if [ "$BUILD" = true ]; then
  docker version >/dev/null 2>&1 || { echo "Docker daemon 未运行"; exit 1; }
  echo "==> docker build"
  # NEXT_PUBLIC_* 是编译期内联值，站点 URL 必须在构建期传入
  docker build -f apps/web/Dockerfile \
    --build-arg NEXT_PUBLIC_SITE_URL="${SITE_URL}" \
    -t "${IMAGE}:${TAG}" -t "${IMAGE}:test-latest" .
  : "${REG_TOKEN:?需要 REG_TOKEN（GitLab PAT，write_repository 权限）}"
  echo "==> docker push"
  echo "${REG_TOKEN}" | docker login "${REGISTRY_HOST}" -u oauth2 --password-stdin
  docker push "${IMAGE}:${TAG}"
  docker push "${IMAGE}:test-latest"
fi

# ---------------------------------------------------------------- 集群准备
echo "==> namespace: ${NAMESPACE}"
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

# 私有仓库拉取凭证（deployment 引用 mycut-registry）
if [ -n "${REG_TOKEN:-}" ]; then
  echo "==> image pull secret: mycut-registry"
  kubectl create secret docker-registry mycut-registry \
    --docker-server="${REGISTRY_HOST}" \
    --docker-username=oauth2 \
    --docker-password="${REG_TOKEN}" \
    --namespace="${NAMESPACE}" \
    --dry-run=client -o yaml | kubectl apply -f -
fi

# 应用凭据（k8s/secrets/test.yaml 内嵌 namespace: mycut-test，gitignored）
[ -f k8s/secrets/test.yaml ] || { echo "缺少 k8s/secrets/test.yaml"; exit 1; }
echo "==> app secret: mycut-secrets"
kubectl apply -f k8s/secrets/test.yaml

# ---------------------------------------------------------------- 迁移
if [ "$SKIP_MIGRATE" = true ]; then
  echo "==> 跳过迁移（--skip-migrate）"
else
  echo "==> migrate: 删旧 Job 重建，等待 Complete"
  kubectl delete job mycut-migrate -n "${NAMESPACE}" --ignore-not-found
  sed "s|registry.example.com/mycut/web:IMAGE_TAG|${IMAGE}:${TAG}|" \
    k8s/base/migrate-job.yaml | kubectl apply -n "${NAMESPACE}" -f -
  kubectl wait --for=condition=complete job/mycut-migrate -n "${NAMESPACE}" --timeout=300s \
    || { kubectl logs job/mycut-migrate -n "${NAMESPACE}" --tail=50; exit 1; }
fi

# ---------------------------------------------------------------- 发布
echo "==> 发布 overlay（镜像 tag 写入 kustomization，避免依赖独立 kustomize 二进制）"
sed -i "s|newName: ${IMAGE}|newName: ${IMAGE}|; s|newTag: .*|newTag: ${TAG}|" k8s/overlays/test/kustomization.yaml
kubectl apply -k k8s/overlays/test
kubectl rollout status deploy/mycut-web -n "${NAMESPACE}" --timeout=300s

# ---------------------------------------------------------------- 验证
echo "==> 验证"
kubectl get pods -n "${NAMESPACE}" -l app.kubernetes.io/name=mycut-web
echo "完成。请用浏览器访问 ${SITE_URL} 验证登录 / 生成 / 素材封面与预览（https 下）。"
