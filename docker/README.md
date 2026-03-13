# Docker 部署指南

## 快速开始

### 方式一：生产环境部署（推荐）

使用本地构建镜像，直接使用本地配置和数据：

```bash
cd docker
docker compose up -d --build
```

### 方式二：开发环境部署

使用开发配置，支持更多调试选项：

```bash
cd docker
docker compose -f docker-compose.build.yml up -d --build
```

## 数据持久化

容器会自动挂载以下本地目录：

- `../configs` → `/app/configs` - 配置文件目录（包含所有 JSON 配置和 runtime 数据库）
- `../logs` → `/app/logs` - 日志文件目录

**重要**：容器会直接使用你本地的配置和数据，无需重新导入。

## 端口映射

- `3000` - 主 API 服务端口
- `8085-8087` - 扩展服务端口
- `1455` - 管理端口
- `19876-19880` - TLS sidecar 端口范围

## 环境变量配置

可以通过 `.env` 文件或命令行传递环境变量：

```bash
# 创建 .env 文件
cat > docker/.env << EOF
ARGS=--port 3000
GOPROXY=https://goproxy.cn,direct
DOCKER_HTTP_PROXY=
DOCKER_HTTPS_PROXY=
EOF
```

## 常用命令

```bash
# 查看日志
docker compose logs -f

# 停止服务
docker compose down

# 重启服务
docker compose restart

# 重新构建并启动
docker compose up -d --build --force-recreate

# 进入容器
docker compose exec all2one-api sh

# 查看容器状态
docker compose ps
```

## 健康检查

容器内置健康检查，每 30 秒检查一次服务状态：

```bash
# 查看健康状态
docker inspect --format='{{.State.Health.Status}}' all2one-api
```

## 故障排查

### 1. 容器无法启动

```bash
# 查看详细日志
docker compose logs all2one-api

# 检查配置文件是否存在
ls -la ../configs/
```

### 2. 配置文件未生效

确保本地配置文件路径正确：
- 配置文件应在 `all2one-api/configs/` 目录下
- 运行 docker compose 时应在 `all2one-api/docker/` 目录下

### 3. 数据库文件权限问题

```bash
# 确保 runtime 目录有正确的权限
chmod -R 755 ../configs/runtime/
```

## 升级镜像

```bash
# 停止并删除旧容器
docker compose down

# 重新构建镜像
docker compose build --no-cache

# 启动新容器
docker compose up -d
```

## 注意事项

1. **首次运行**：确保 `configs/` 目录下有必要的配置文件（config.json 等）
2. **数据安全**：容器直接使用本地数据，请定期备份 `configs/runtime/` 目录
3. **端口冲突**：如果端口被占用，可以修改 `docker-compose.yml` 中的端口映射
4. **代理设置**：如果需要使用代理，在 `.env` 文件中配置 `DOCKER_HTTP_PROXY` 和 `DOCKER_HTTPS_PROXY`
