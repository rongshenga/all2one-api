# syntax=docker/dockerfile:1.7

# ── Stage 1: 编译 Go TLS sidecar ──
FROM golang:1.22-alpine AS sidecar-builder

RUN apk add --no-cache git

WORKDIR /build
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ARG GOPROXY=https://goproxy.cn,direct
ARG GOSUMDB=sum.golang.org
ENV GOPROXY=${GOPROXY} \
    GOSUMDB=${GOSUMDB}

COPY tls-sidecar/go.mod tls-sidecar/go.sum* ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    sh -c 'for i in 1 2 3; do \
        go mod download && exit 0; \
        echo "[sidecar-builder] go mod download failed, retry ${i}/3"; \
        sleep $((i * 2)); \
    done; exit 1'

COPY tls-sidecar/ ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o tls-sidecar .

# ── Stage 2: Node.js 应用 ──
# 使用官方 Node.js 运行时作为基础镜像
# 选择 20-alpine 版本以满足 undici 包的要求（需要 Node.js >=20.18.1）
FROM node:20-alpine

ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"
ENV NODE_ENV=production

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY

# 设置标签
LABEL maintainer="All2One API Team"
LABEL description="Docker image for All2One API server"

# 安装必要的系统工具（tar 用于更新功能，git 用于版本检查，sqlite 提供 sqlite3 CLI）
RUN apk add --no-cache tar git sqlite

# 设置工作目录
WORKDIR /app

# 启用 corepack，并使用仓库声明的 pnpm 版本
RUN corepack enable

# 复制 package.json 和 pnpm 锁文件
COPY package.json pnpm-lock.yaml ./

# 安装依赖（使用 --prod 只安装生产依赖，减小镜像大小）
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --prod --frozen-lockfile

# 复制源代码（只复制必要的目录，减小镜像大小）
COPY src ./src
COPY web ./web
COPY healthcheck.js ./

# 从 sidecar 构建阶段复制二进制
COPY --from=sidecar-builder /build/tls-sidecar /app/tls-sidecar/tls-sidecar
RUN chmod +x /app/tls-sidecar/tls-sidecar

# 创建目录用于存储日志和配置文件
# 注意：实际的配置文件应通过 volume 挂载本地目录
RUN mkdir -p /app/logs /app/configs/runtime

# 暴露端口
EXPOSE 3000 8085-8087 1455 19876-19880

# 添加健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node healthcheck.js || exit 1

# 设置启动命令
# 使用默认配置启动服务器，支持通过环境变量配置
# 通过环境变量传递参数，例如：docker run -e ARGS="--api-key mykey --port 8080" ...
CMD ["sh", "-c", "node src/core/master.js $ARGS"]
