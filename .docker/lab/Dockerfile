# Isolated development fixture. No host sockets or daemon access.
ARG DEV_IMAGE=mtmux-dev:local
FROM ${DEV_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    procps less vim-tiny ncurses-bin ncurses-term locales \
    && sed -i 's/^# *\(en_US.UTF-8\)/\1/' /etc/locale.gen \
    && locale-gen en_US.UTF-8 && rm -rf /var/lib/apt/lists/*
COPY .docker/lab /lab
RUN chmod +x /lab/seed.sh /lab/entrypoint.sh /lab/gen.py
USER node
ENV HOME=/tmp/lab LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \
    TERM=xterm-256color LAB_SOCKET=/run/lab/tmux.sock \
    TMUX_SOCKET=/run/lab/tmux.sock TMUX_DEFAULT_SHELL=/bin/bash \
    RELAY_HOST=0.0.0.0 RELAY_PORT=24300 ALLOWED_PATHS=/lab
HEALTHCHECK --interval=3s --timeout=5s --start-period=90s --retries=40 \
    CMD /lab/seed.sh check
ENTRYPOINT ["/lab/entrypoint.sh"]
