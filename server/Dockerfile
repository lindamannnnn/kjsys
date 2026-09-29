# 基础镜像可替换：国内网络直连 Docker Hub 常失败，
# 部署时可用 --build-arg BASE_IMAGE=docker.1panel.live/library/node:20-alpine 换源
ARG BASE_IMAGE=node:20-alpine
FROM ${BASE_IMAGE}

# 时区设为上海，避免单据时间偏差
ENV TZ=Asia/Shanghai
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone

WORKDIR /app

# 先装依赖，利用 Docker 层缓存
COPY package*.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com

# 再复制源码
COPY . .

# 上传目录
RUN mkdir -p /app/uploads

EXPOSE 3000

CMD ["node", "src/app.js"]
