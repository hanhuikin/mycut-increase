# MyCut（OpenCut 改版）K8s 打包部署方案

> 版本 v1 · 结合 `docs/后续开发规划.md`（P4 部署与运维）、`Dockerfile`、`docker-compose.yml` 现状整理，目标是以 Kubernetes 为目标环境完成打包与部署。
> 本方案覆盖：镜像构建、K8s 资源清单（可直接套用）、数据库迁移、发布与回滚、多副本注意事项、分期落地清单。

---

## 1. 应用架构与部署单元

| 组件 | 形态 | 说明 |
|---|---|---|
| **web** | Next.js 16（`output: "standalone"`） | 无状态；端口 3000；进程内含 AI 任务惰性同步（见 §6）；健康检查 `/api/health`（存活）与 `/api/health/deep`（就绪，含 DB 连通） |
| **PostgreSQL 17** | 有状态 | 业务库（`app` schema）；schema 由 drizzle 迁移管理（`apps/web/migrations`） |
| **Redis 7** | 有状态/托管 | better-auth 限流 secondary-storage + AI 接口限流；客户端为 ioredis 直连（`REDIS_URL`），**失败自动降级放行**，短时不可用不致瘫 |
| ~~serverless-redis-http~~ | 不部署 | 早期 Upstash REST 代理残留，现代码已改为 ioredis 直连，K8s 内不需要 |

浏览器端说明：素材（上传/生成的视频）存储在**用户浏览器本地**（IndexedDB），服务端不落媒体文件；生成结果的厂商签名 URL 有效期 7 天，入库动作在浏览器完成。因此 web 服务本身**无持久卷需求**，可以任意扩缩。

---

## 2. 前置修复（已随本方案完成）

`Dockerfile` 的构建期 env stub 已过期：原来注入的是 `UPSTASH_REDIS_REST_URL/TOKEN`，而现网代码 `src/env/web.ts` 的 zod schema 要求 **`REDIS_URL`**（ioredis 直连），缺失会在 `next build` 与容器启动时直接抛错。已将 stub 替换为：

```dockerfile
ENV REDIS_URL="redis://:build-time@localhost:6379"
```

> 规则：**运行时 env 变更必须同步检查 `Dockerfile` 的 build stubs 与本文件 §3.3 的环境变量清单**，三处一致。

---

## 3. 镜像构建

### 3.1 构建流程

多阶段构建（bun alpine）：builder 阶段 `bun install` → `bun run build`（Next standalone 产物）→ runner 阶段仅拷贝 `standalone + static + public`，非 root 用户运行。

```bash
# 构建参数说明（全部为构建期注入；运行时可被环境变量覆盖）
#   NEXT_PUBLIC_SITE_URL       ★ 必须是最终对外域名（会被打进客户端产物，发布后改域名需重建镜像）
docker build \
  -f Dockerfile \
  --build-arg NEXT_PUBLIC_SITE_URL="https://mycut.example.com" \
  -t registry.example.com/mycut/web:1.0.0 .
docker push registry.example.com/mycut/web:1.0.0
```

**tag 规范**：语义化版本 + 短 commit（`1.0.0-89846d3`）；`latest` 仅指向最近一次通过验证的版本，禁止在生产直接滚动 `latest`。

**CI 建议**（一期可手动执行，二期接 GitHub Actions / 内网 CI）：lint + tsc → docker build → push → `kubectl set image`（或 helm upgrade）。

### 3.2 运行时环境变量清单

| 变量 | 必需 | 说明 |
|---|---|---|
| `NODE_ENV` | 是 | `production` |
| `DATABASE_URL` | 是 | `postgresql://user:pass@host:5432/db`（Postgres 17） |
| `BETTER_AUTH_SECRET` | 是 | ≥32 字符随机串；**轮换会使全部会话失效** |
| `REDIS_URL` | 是 | `redis://:pass@host:6379` |
| `NEXT_PUBLIC_SITE_URL` | 是 | 对外域名（better-auth trustedOrigins 依赖它，与 Ingress 域名一致） |
| `MODEL_CREDENTIALS_KEY` | **是**（用 AI 渠道时） | 64 位 hex（32 字节）；**加密数据库中的渠道密钥，多副本必须一致，丢失即全部渠道密钥不可解** |

### 3.3 构建期注意事项

- `env/web.ts` 在模块加载时做 zod 校验，缺变量 = 进程无法启动——这也是 §2 修复的原因。
- `MODEL_CREDENTIALS_KEY` 与 `BETTER_AUTH_SECRET` 属于**不可丢失**的密钥：进 Secret 后另存密码管理库，备份副本丢失会导致渠道密钥与登录态不可恢复。

---

## 4. K8s 资源设计

### 4.0 双环境清单（最终形态）

PostgreSQL 与 Redis 由外部独立部署（测试/生产各一套），K8s 只部署 web 应用。清单已按 kustomize 双 overlay 组织在 **`k8s/`** 目录，部署步骤见 **`k8s/README.md`**：

| | `k8s/overlays/test` | `k8s/overlays/prod` |
|---|---|---|
| 命名空间 | `mycut-test` | `mycut-prod` |
| 副本 | 1 | 2 + HPA(2→6) |
| 域名 | `test.mycut.example.com` | `mycut.example.com`（TLS） |
| 资源 | 100m/384Mi 起步 | 250m/512Mi 起步 |
| DB/Redis | 外部测试实例（Secret 指向） | 外部生产实例（Secret 指向） |

以下 §4.1–§4.6 是单文件参考视图（与 kustomize 内容等价），维护以 `k8s/` 目录为准。

### 4.1 Namespace 与 Secret

```yaml
# k8s/00-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: mycut
---
# k8s/01-secret.yaml —— 模板：先用脚本填充，切勿把真实值提交进仓库
apiVersion: v1
kind: Secret
metadata:
  name: mycut-secrets
  namespace: mycut
type: Opaque
stringData:
  DATABASE_URL: "postgresql://mycut:CHANGE_ME@postgres.mycut.svc:5432/mycut"
  BETTER_AUTH_SECRET: "CHANGE_ME_openssl_rand_base64_32"
  REDIS_URL: "redis://:CHANGE_ME@redis.mycut.svc:6379"
  MODEL_CREDENTIALS_KEY: "CHANGE_ME_64_hex_chars_32_bytes"
```

### 4.2 数据库迁移（Job，发布前执行）

迁移由 drizzle 管理（`apps/web/migrations`，**不使用** `db:push` 于生产）。用镜像内自带的依赖跑 migrate：

```yaml
# k8s/02-migrate-job.yaml —— 每次发布前手动/流水线执行
apiVersion: batch/v1
kind: Job
metadata:
  name: mycut-migrate
  namespace: mycut
spec:
  backoffLimit: 1
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: registry.example.com/mycut/web:1.0.0
          command: ["bun", "run", "db:migrate"]
          workingDir: /app/apps/web
          envFrom:
            - secretRef: { name: mycut-secrets }
```

> migrate 需要 `drizzle.config.ts` 与 `migrations/` —— standalone 产物不含它们，**迁移 Job 建议直接用完整构建镜像**（同 tag），或在镜像里额外拷贝这两个路径（见 §3 的 Dockerfile 可选项）。执行约定：`kubectl -n mycut delete job mycut-migrate; kubectl apply -f 02-migrate-job.yaml && kubectl wait --for=condition=complete job/mycut-migrate -n mycut --timeout=180s`。

### 4.3 web Deployment + Service + Ingress

```yaml
# k8s/03-web.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mycut-web
  namespace: mycut
spec:
  replicas: 2                # 任务同步已加 advisory lock（见 §6），多副本安全；可配 HPA 扩到 6
  strategy:
    type: RollingUpdate
    rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }
  selector:
    matchLabels: { app: mycut-web }
  template:
    metadata:
      labels: { app: mycut-web }
    spec:
      containers:
        - name: web
          image: registry.example.com/mycut/web:1.0.0
          ports: [{ containerPort: 3000 }]
          envFrom:
            - secretRef: { name: mycut-secrets }
          env:
            - name: NODE_ENV
              value: production
            - name: NEXT_PUBLIC_SITE_URL
              value: "https://mycut.example.com"     # 与 Ingress 域名一致；纯公网变量也可放 ConfigMap
          resources:
            requests: { cpu: 250m, memory: 512Mi }
            limits: { cpu: "1", memory: 1Gi }
          startupProbe:                              # Next 冷启动 + 首次编译产物加载
            httpGet: { path: /api/health, port: 3000 }
            failureThreshold: 30
            periodSeconds: 2
          livenessProbe:
            httpGet: { path: /api/health, port: 3000 }
            periodSeconds: 15
            timeoutSeconds: 3
          readinessProbe:                            # DB 不通即摘除流量（/api/health/deep 返回 503）
            httpGet: { path: /api/health/deep, port: 3000 }
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
---
apiVersion: v1
kind: Service
metadata:
  name: mycut-web
  namespace: mycut
spec:
  selector: { app: mycut-web }
  ports: [{ port: 80, targetPort: 3000 }]
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: mycut-web
  namespace: mycut
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"   # 图片素材走客户端直传，这里仅为接口兜底
spec:
  ingressClassName: nginx
  rules:
    - host: mycut.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: mycut-web, port: { number: 80 } } }
  # tls:
  #   - hosts: [mycut.example.com]
  #     secretName: mycut-tls
```

### 4.4 Redis（外部独立部署）

限流数据可容忍丢失（fail-open），无持久化需求。**K8s 不部署 Redis**——测试/生产各有一套独立实例，`REDIS_URL` 直接指向（见 `k8s/secret.example.yaml`）。唯一的软要求：外部 Redis 需允许来自 K8s 节点的访问（网络策略/防火墙放行）。

### 4.5 PostgreSQL（外部独立部署）

生产与测试库均独立部署，应用侧只持有 `DATABASE_URL`。要点：

- 迁移仍由应用侧 Job 执行（§4.2），首次建表也是跑一次 migrate Job。
- 数据库自身的高可用/备份由部署方负责；应用无状态，随时可重建。
- 存量数据搬迁用 pg_dump/pg_restore（`db-export/` 有导出流程，注意其中 DML 含敏感行不入仓库）。

### 4.6 可选增强（二期）

```yaml
# HPA（加固多副本后启用）
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: mycut-web, namespace: mycut }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: mycut-web }
  minReplicas: 2
  maxReplicas: 6
  metrics:
    - type: Resource
      resource: { name: memory, target: { type: Utilization, averageUtilization: 75 } }
```

NetworkPolicy（限制 redis/pg 仅接受 mycut-web）、PodDisruptionBudget、TLS cert-manager 按需补充。

---

## 5. 发布与回滚流程

```
构建镜像(tag) → 跑迁移 Job → kubectl set image（滚动）→ 观察 readiness/日志 → 验证
回滚：kubectl rollout undo deployment/mycut-web（镜像回退；迁移不做反向——要求迁移始终向后兼容）
```

**迁移纪律**：drizzle 迁移只新增/向后兼容；删除列/破坏性变更必须在下一个版本（代码已不再读写旧列之后）的迁移里做。滚动期间新旧两个版本会同时在线。

---

## 6. 多副本并发说明（任务队列）

AI 生成的状态同步是**请求内惰性执行**（读 `/api/ai/tasks` 时就地 poll 上游、结算/退点/渠道回退）。多副本会并发同步同一任务——结算/退款已由 `credit_ledger(kind, ref_id)` 唯一索引保证幂等，但**渠道回退会重复向上游提交**（冻结不幂等）。

**已加固（随本方案落地）**：`services/ai/tasks.ts` 的 `syncTask` 入口加了 Postgres 会话级 advisory lock（`pg_try_advisory_lock(hashtext(task.id))`，专用单连接 `reserve()` 会话）。抢不到锁的副本直接返回当前行、下次读取再追赶；锁随连接关闭自动释放，pod 崩溃不会卡死任务。已在 Postgres 17 上实测互斥语义（持锁拒绝 / 会话退出自动释放）。

因此 **`replicas ≥ 2` 可以直接启用**（§4.6 的 HPA 随时可开）。唯一保留的约束：进行中任务的轮询同步频率与上游压力成正比，多副本下同一任务最多仍只有一个副本在同步。

分镜批次提交是多次独立 HTTP 请求，天然分散，无额外要求。

---

## 7. 可观测性

- 探针：liveness `/api/health`（纯进程）；readiness `/api/health/deep`（含 DB）。Redis 故障为降级而非摘除（限流 fail-open），不进探针。
- 日志：stdout JSON 由节点采集；关注 `refund failed`、`settle failed`、`Redis error`、`任务队列` 相关行——它们代表资金/任务链路异常。
- 关键业务指标（二期）：任务成功率、生成耗时分布、渠道回退次数、冻结/结算差额。

---

## 8. 分期落地清单

**P0 最小可用**：修复 Dockerfile stubs（已完成）→ 构建镜像 → kustomize 双 overlay（`k8s/overlays/test|prod`）+ migrate Job → 验证注册/登录/生成一条龙。

**P1 生产化**：TLS（prod overlay 已含 cert-manager 注解，需装 cert-manager）；镜像 CI；`db-export/` 定时备份任务；日志采集。

**P2 扩展**：多副本 + HPA（prod overlay 已含，advisory lock 已加固）；NetworkPolicy；导出/系统通知接入头部通知中心。

---

## 附：与旧部署形态的关系

- `docker-compose.yml`（单机 dev/演示）继续可用；其 `serverless-redis-http` 服务在 K8s 形态中**不需要**。
- Railway 形态（`railway.toml` + Dockerfile build args 注入）保留为备选，与 K8s 共用同一镜像。
- `db-export/` 的 DDL/DML 导出可作为迁移到 K8s 数据库时的数据搬运输入（注意其中的敏感行，勿入仓库）。
