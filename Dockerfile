# Окружение разработки: Node + wrangler/workerd + тесты. Код монтируется томом (compose.yaml).
# glibc-образ (не alpine): workerd требует glibc.
FROM node:26-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV WRANGLER_SEND_METRICS=false \
    NODE_ENV=development

COPY package.json package-lock.json ./
RUN npm ci

EXPOSE 8787
CMD ["npm", "test"]
