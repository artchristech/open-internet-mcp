FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npx tsc && chmod +x dist/index.js

# Smithery will spawn this over stdio.
CMD ["node", "dist/index.js"]
