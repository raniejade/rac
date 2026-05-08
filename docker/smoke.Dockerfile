FROM node:22-bookworm-slim AS smoke-test

ENV NPM_CONFIG_CACHE=/tmp/.npm-cache
ENV CLAUDE_CODE_VERSION=@anthropic-ai/claude-code@2.1.133
ENV CODEX_VERSION=@openai/codex@0.129.0
ENV OPENCODE_VERSION=opencode-ai@1.14.35

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .
RUN npm ci

RUN npm install -g "$CLAUDE_CODE_VERSION" "$CODEX_VERSION" "$OPENCODE_VERSION"
RUN claude --version && codex --version && opencode --version

RUN npm run test:harness
