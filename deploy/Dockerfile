# blindbook-api, blindbook-signer and blindbook-verify for Linux, from the locked dependencies.
# Build from the repository root:
#   docker build -f deploy/Dockerfile -t blindbook:latest .
FROM rust:1.95-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release --locked -p blindbook-api -p blindbook-signer -p blindbook-verify

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 blindbook \
 && useradd --system --uid 10001 --gid 10001 --create-home --home-dir /home/blindbook blindbook \
 && mkdir -p /data && chown blindbook /data
COPY --from=build /src/target/release/blindbook-api /src/target/release/blindbook-signer /src/target/release/blindbook-verify /usr/local/bin/
USER blindbook
WORKDIR /data
