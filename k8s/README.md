# MyCut K8s 部署（kustomize）

Web 应用的 Kubernetes 打包部署。**PostgreSQL 与 Redis 由外部独立部署**（测试/生产各一套），本目录只部署 web 应用本身；连接凭据全部走 `mycut-secrets`。

```
k8s/
├── base/                     # 通用清单（Deployment/Service/迁移 Job）
├── overlays/
│   ├── test/                 # 测试环境：单副本、低资源、test-mycut.sunwin-sh.com
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
docker build -f Dockerfile \
  --build-arg NEXT_PUBLIC_SITE_URL="https://test-mycut.sunwin-sh.com" \
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
docker build -f Dockerfile \
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

## 构建机 / UAT 服务器直建镜像（harbor）

不走 `deploy-test.sh`（本机无 docker/kubeconfig）时，可在服务器上直接构建。**务必用 nohup 或 tmux**：
SSH 终端里直接跑 `docker build`，会话一断 BuildKit 立即取消构建（报 `Canceled: context canceled`）。

```bash
cd /path/to/mycut
git pull
nohup docker build -t harbor.sunwin-sh.com/uat/mycut:$(date +%m%d%H%M) . \
  > build-$(date +%m%d%H%M).log 2>&1 &
tail -f build-*.log        # 看进度；Ctrl+C 退出 tail 不影响构建

# 完成后推送（k8s 拉取 harbor 私有仓需对应 imagePullSecret）
docker login harbor.sunwin-sh.com
docker push harbor.sunwin-sh.com/uat/mycut:<tag>
```

- **首次构建 `RUN bun install` 需 1~3 分钟属正常**（依赖走 npmmirror 国内源，底座走 1panel 国内镜像、apk 走阿里云源），成功一次后该层进缓存，后续秒过。
- 依赖清单（`package.json`/`bun.lock`）不变时，源码改动不会使 `bun install` 层缓存失效。
- tag 用不可变时间戳（如 `110503`），不要用 `latest` 浮动 tag，回滚才有据可依。

## 环境差异

| | test | prod |
|---|---|---|
| 命名空间 | `mycut-test` | `mycut-prod` |
| 副本 | 1 | 2 + HPA(2→6, memory 75%) |
| 资源 | 100m/384Mi ~ 500m/768Mi | 250m/512Mi ~ 1CPU/1Gi |
| 域名 | `test-mycut.sunwin-sh.com` | `mycut.example.com`（TLS） |
| 数据库/Redis | 外部测试实例 | 外部生产实例 |
| Secret | `mycut-secrets`（指向测试库） | 同名（指向生产库） |
| 日志 env 字段 | `test`（APP_ENV） | `prod`（APP_ENV） |

## 日志规范（services/logging/）

应用输出**一行一条 JSON**到 stdout/stderr，本地 dev、test、prod 三种环境都有输出，可直接被
`docker logs` / `kubectl logs` / Loki 采集，无需解析器。字段对齐运维样例：

```json
{"timestamp":"2026-11-05T12:34:56.789Z","level":"INFO","service":"mycut-web","env":"test","trace_id":"a1b2c3d4e5f6","remote_addr":"192.168.1.100","user_id":"u_x","request_method":"GET","request_uri":"/api/ai/tasks","status":200,"body_bytes_sent":12456,"http_referer":"…","http_user_agent":"Mozilla/5.0 …","latency_ms":235,"upstream_response_time":235,"host":"test-mycut.sunwin-sh.com","msg":"api request"}
```

- **trace_id**：客户端会话生成（12 位 hex），每个 `/api/*` 请求经 `x-trace-id` 头带到服务端；服务端日志、响应头 `x-trace-id`、页面展示（登录报错下方 / `window.__TRACE_ID__` / `<html data-trace-id>`）三处一致，报障时让用户提供该 id 即可精确定位。
- **级别**：`LOG_LEVEL`（服务端，默认 prod/test=INFO、dev=DEBUG）。DEBUG 含 /api/health 探活；4xx=WARN，5xx/未捕获异常=ERROR。
- **取帧性能埋点**：构建期 `--build-arg NEXT_PUBLIC_DEBUG_FRAMES=1`（或本地 `.env.local`）后，客户端放开 DEBUG 并输出 `frames.extract` / `frames.batch` / `frames.preview` 的 decode/encode/延迟耗时；发布脚本用 `./script/deploy-test.sh --build --debug-frames` 开启。
- **better-auth** 日志已接入同一格式（含限流触发记录）；密码/密钥类字段自动 `[redacted]`。
- 注意：Next 生产构建默认剥离业务代码里的 `console.*`（保留 error/warn）；需要打的日志一律走 `@/services/logging/logger`，它通过绑定的 console 引用输出，不会被剥离。

### 日志查看与故障定位

**应用不落盘日志文件**——只有 stdout JSON 行，由容器运行时收集（12-factor 规范）：

```bash
# 本地容器（localhost:3000）
docker compose logs -f web                     # 跟踪
docker compose logs web --since 10m            # 最近10分钟
docker compose logs web > mycut.log            # 需要文件就重定向导出

# k8s（单副本 / 多副本）
kubectl -n mycut-test logs -f deploy/mycut-web
kubectl -n mycut-test logs -f -l app.kubernetes.io/name=mycut-web --prefix --tail=100

# dev server：终端直接输出；要文件就重定向
cd apps/web && bun run dev > /tmp/mycut-dev.log 2>&1
```

**按 trace_id 定位一次用户报障**（标准流程）：

```bash
# 1. 用户提供页面上的 trace_id（登录报错下方 / <html data-trace-id> / window.__TRACE_ID__）
kubectl -n mycut-test logs --since=2h -l app.kubernetes.io/name=mycut-web --prefix \
  | grep '"trace_id":"a59ffc592c64"'
# 2. 相同 trace_id 的所有行 = 这一次会话的 API 调用、better-auth 详情（如 Invalid password）、
#    状态码与耗时；多副本用 --prefix 区分是哪个 pod 处理的
```

浏览器端同格式 JSON（API 4xx/5xx、window error、取帧埋点）在 DevTools Console，trace_id 与服务端一致。

## 注意事项

- **Secret 不入库**：`k8s/secret.yaml` 已在 `.gitignore`；`secret.example.yaml` 是唯一模板。`MODEL_CREDENTIALS_KEY` 与 `BETTER_AUTH_SECRET` 属不可丢失项，另存密码管理库。
- **`NEXT_PUBLIC_SITE_URL` 必须在运行时注入**（Deployment env ← ConfigMap）。服务端 better-auth 用它做 `baseURL` 与 Origin 白名单；缺失时 zod 回退到 `http://localhost:3000`，浏览器从真实域名登录会被判 `Invalid origin`（403）。当前代码只有服务端引用它，**换域名只需改 ConfigMap 并 `rollout restart`，不必重建镜像**；Dockerfile 的 `--build-arg` 只是兜底。
- 若还要从其它域名/IP 访问（LAN 地址、备用域名），在 Secret 里加 `TRUSTED_ORIGINS`（逗号分隔）；否则登录同样被 Origin 校验拒绝。
- 迁移 Job 用与 web 相同的镜像（要求镜像内含 `migrations/` 与 `drizzle.config.ts`，见方案文档 §4.2 的 Dockerfile 可选层说明）。
- 多副本安全：任务惰性同步已加 advisory lock（详见 docs/K8s打包部署方案.md §6）。

---

> **最后更新**：2026-11-06 —— 新增「日志查看与故障定位」「构建机 / UAT 服务器直建镜像（harbor）」章节，日志规范含 trace_id 全链路说明。

