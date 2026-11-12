FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY agent ./agent
COPY src ./src
COPY web ./web
COPY fixtures ./fixtures
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
