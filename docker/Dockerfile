FROM node:22-trixie-slim
WORKDIR /app
RUN apt-get -q update && apt-get install -qy ripgrep && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
# --omit=dev is safe: tests use node:test (stdlib), devDeps are only eslint/prettier
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
