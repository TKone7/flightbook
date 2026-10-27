FROM node:24-alpine AS dist
WORKDIR /tmp/
COPY package.json package-lock.json tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src/ src/
RUN npm ci
RUN npm run build

FROM node:24-alpine AS node_modules
RUN apk add build-base
WORKDIR /tmp/
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine
RUN apk add tzdata
RUN cp /usr/share/zoneinfo/Europe/Zurich /etc/localtime
RUN echo "Europe/Zurich" >  /etc/timezone
RUN apk del tzdata
WORKDIR /usr/local/nub-api
COPY --from=node_modules /tmp/node_modules ./node_modules
COPY --from=dist /tmp/dist ./dist
CMD ["node", "dist/main.js"]
