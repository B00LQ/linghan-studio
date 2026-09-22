# Studio —— 自托管 AI 创作台
#
# 单阶段构建：镜像里既有前端构建产物，也有直接运行 TS 的服务端。
# 用 Node 24 是因为服务端依赖 node:sqlite，它在 24 上无需实验开关。
# 基础镜像参数化：默认走 Docker Hub；拉不动时用 build arg 换成可达的镜像源
# （例如 docker.m.daocloud.io/library/node:24-alpine），Dockerfile 本身保持可移植。
ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE}

WORKDIR /app

# pnpm 由 corepack 提供，版本取自根 package.json 的 packageManager 字段。
RUN corepack enable

COPY . .

# devDependencies 是构建前端所必需的，因此这里不做 --prod 裁剪。
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @studio/web build \
  && pnpm store prune

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    STUDIO_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8080

# 未设置 STUDIO_PASSWORD 时登录门会关闭，仅适合本机开发。
CMD ["node", "--experimental-strip-types", "apps/server/src/index.ts"]
