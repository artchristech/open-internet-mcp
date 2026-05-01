FROM node:20-bookworm-slim AS mcp
WORKDIR /mcp
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npx tsc && chmod +x dist/index.js

FROM python:3.11-slim
WORKDIR /app

# Bring node along so `npx open-internet-mcp` and the local dist both work.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

COPY --from=mcp /mcp /opt/open-internet-mcp

COPY gateway/pyproject.toml ./
RUN pip install --no-cache-dir fastapi 'uvicorn[standard]' httpx pydantic

COPY gateway/app ./app

ENV OPEN_INTERNET_MCP_CMD="node /opt/open-internet-mcp/dist/index.js"
ENV PORT=8088
EXPOSE 8088
CMD ["python", "-m", "app.main"]
