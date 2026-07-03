# 使用官方轻量级 Deno 镜像
FROM denoland/deno:alpine-1.44.4

# 创建非 root 的高安全普通用户
RUN addgroup -S lowcode && adduser -S sandbox -G lowcode

WORKDIR /app

# 💡 关键：DENO_DIR 必须在任何 deno run/cache 之前设置，保证预热缓存写到运行时实际使用的目录。
# （历史版本将 ENV 放在 preload 之后，导致预热的 Pyodide Wasm 缓存进了 root home，
#  运行时 sandbox 用户根本读不到，每个 Worker 还要重新下载——预热失效。）
ENV DENO_DIR=/app/.deno_cache
RUN mkdir -p /app/.deno_cache

# 阶段一：构建时开启网络，将 Pyodide Wasm 及 numpy/pandas 预编译产物固化到 /app/.deno_cache
COPY preload.ts .
RUN deno run --allow-net --allow-read --allow-write --allow-env preload.ts

# 阶段二：拷入业务源码并预缓存依赖（npm:pyodide 元数据等）
COPY server.ts python_pool.ts python_runner.ts ./
RUN deno cache server.ts python_pool.ts python_runner.ts

# 将整个 /app（包含 .deno_cache 与源码）转让给低权限用户
RUN chown -R sandbox:lowcode /app

USER sandbox
EXPOSE 8126

# 运行时可调环境变量（由 K8s ConfigMap/Secret 注入，Dockerfile 中故意不设默认值）：
#   SANDBOX_API_KEY        必填，长度 >= 16；缺失时进程直接退出 1
#   SANDBOX_POOL_SIZE      Python Worker 常驻池大小，默认 1
#   SANDBOX_MAX_QUEUE      Python 排队上限，溢出时网关返回 429，默认 32
#   SANDBOX_MAX_CODE_BYTES 单次请求 code 字节上限，溢出返回 413，默认 65536
#
# 运行期权限：
#   --allow-net   主进程需要监听 8126；npm:pyodide 解析也走 net 子系统
#   --allow-env   读取 SANDBOX_* 配置
#   --allow-read  读 python_runner.ts 源码 + Deno 缓存
#   --allow-write 锁死仅可写 app.log（运行期日志）
#   --unstable-worker-options 必需，Worker 细粒度权限隔离
#   --v8-flags    V8 老生代堆上限 512MB，OOM 时崩溃在容器内不波及宿主
ENTRYPOINT ["deno", "run", \
    "--allow-net", \
    "--allow-env=SANDBOX_API_KEY,SANDBOX_POOL_SIZE,SANDBOX_MAX_QUEUE,SANDBOX_MAX_CODE_BYTES", \
    "--allow-read=/app", \
    "--allow-write=./app.log", \
    "--unstable-worker-options", \
    "--v8-flags=--max-old-space-size=512", \
    "server.ts"]
