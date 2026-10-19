FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs store.mjs ./
COPY scripts ./scripts
USER node
EXPOSE 8788
CMD ["node", "server.mjs"]
