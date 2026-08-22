# Stage 0: build
FROM oven/bun:latest AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
COPY workspace-template ./workspace-template
COPY gods ./gods

# Stage 1: prod
FROM oven/bun:latest AS prod

ARG UID=1000
ARG GID=1000

WORKDIR /app

COPY --from=build --chown=${UID}:${GID} /app /app

COPY --chown=root:root docker/entrypoint.sh /usr/local/bin/pantheon-entrypoint
RUN chmod 755 /usr/local/bin/pantheon-entrypoint

USER ${UID}:${GID}

ENV HOME=/home/openclaw

ENTRYPOINT ["/usr/local/bin/pantheon-entrypoint"]