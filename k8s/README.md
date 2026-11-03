# MyCut K8s 部署（kustomize）

Web 应用的 Kubernetes 打包部署。**PostgreSQL 与 Redis 由外部独立部署**（测试/生产各一套），本目录只部署 web 应用本身；连接凭据全部走 `mycut-secrets`。

```
k8s/
├── base/                     # 通用清单（Deployment/Service/迁移 Job）
├── overlays/
│   ├── test/                 # 测试环境：单副本、低资源、test.mycut.example.com
│   └── prod/                 # 生产环境：双副本 + HPA、生产域名 + TLS
├── secret.example.yaml       # Secret 模板（含全部必需变量的说明）
└── README.md
```

## 首次部署（每环境一次）

```bash
# 1. 建命名空间与 Secret（值指向该环境的数据库/Redis）
kubectl create namespace mycut-test
cp k8s/secret.example.yaml k8s/secret.yaml   # 填入测试环境真实值
kubectl -n mycut-test apply -f k8s/secret.yaml

# 2. 构建镜像（CI 或手动，见 docs/K8s打包部署方案.md §3）
docker build -f apps/web/Dockerfile \
  --build-arg NEXT_PUBLIC_SITE_URL="https://test.mycut.example.com" \
  -t registry.example.com/mycut/web:test-latest .
docker push registry.example.com/mycut/web:test-latest

# 3. 迁移（首次建表；后续发布也先跑）
kubectl -n mycut-test delete job mycut-migrate --ignore-not-found
kubectl apply -k k8s/overlays/test
kubectl -n mycut-test wait --for=condition=complete job/mycut-migrate --timeout=180s

# 4. 起 web
kubectl -n mycut-test delete pod -l app.kubernetes.io/name=mycut-web   # 让 Deployment 用最新镜像拉起
kubectl -n mycut-test rollout status deployment/mycut-web --timeout=180s
```

## 日常发布（每环境）

```bash
ENV=test          # 或 prod
TAG=<new-tag>

# 1. 构建推送镜像
docker build -f apps/web/Dockerfile \
  --build-arg NEXT_PUBLIC_SITE_URL="https://<env-domain>" \
  -t registry.example.com/mycut/web:$TAG .
docker push registry.example.com/mycut/web:$TAG

# 2. 更新 overlay 的 newTag（提交到 git，环境漂移可追溯）
kustomize edit set image registry.example.com/mycut/web:$TAG   # 在 k8s/overlays/$ENV 下执行

# 3. 迁移 → 滚动
kubectl -n mycut-$ENV delete job mycut-migrate --ignore-not-found
kubectl apply -k k8s/overlays/$ENV
kubectl -n mycut-$ENV wait --for=condition=complete job/mycut-migrate --timeout=180s
kubectl -n mycut-$ENV rollout status deployment/mycut-web --timeout=180s

# 回滚：kubectl -n mycut-$ENV rollout undo deployment/mycut-web
```

## 环境差异

| | test | prod |
|---|---|---|
| 命名空间 | `mycut-test` | `mycut-prod` |
| 副本 | 1 | 2 + HPA(2→6, memory 75%) |
| 资源 | 100m/384Mi ~ 500m/768Mi | 250m/512Mi ~ 1CPU/1Gi |
| 域名 | `test.mycut.example.com` | `mycut.example.com`（TLS） |
| 数据库/Redis | 外部测试实例 | 外部生产实例 |
| Secret | `mycut-secrets`（指向测试库） | 同名（指向生产库） |

## 注意事项

- **Secret 不入库**：`k8s/secret.yaml` 已在 `.gitignore`；`secret.example.yaml` 是唯一模板。`MODEL_CREDENTIALS_KEY` 与 `BETTER_AUTH_SECRET` 属不可丢失项，另存密码管理库。
- **`NEXT_PUBLIC_SITE_URL` 是构建期变量**：打进客户端产物。换域名需要**重建镜像**，不是改 ConfigMap——每个环境构建时传对应的 `--build-arg`。
- **`NEXT_PUBLIC_*` 在 ConfigMap 里只用于运行时注入**，与构建值需保持一致。
- 迁移 Job 用与 web 相同的镜像（要求镜像内含 `migrations/` 与 `drizzle.config.ts`，见方案文档 §4.2 的 Dockerfile 可选层说明）。
- 多副本安全：任务惰性同步已加 advisory lock（详见 docs/K8s打包部署方案.md §6）。
