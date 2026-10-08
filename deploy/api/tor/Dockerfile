# A Tor onion service for the .onion mirror: the app and the API, carried by Tor end to end.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends tor \
 && rm -rf /var/lib/apt/lists/*
COPY torrc /etc/tor/torrc
USER debian-tor
CMD ["tor", "-f", "/etc/tor/torrc"]
