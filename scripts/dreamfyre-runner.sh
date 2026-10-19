#!/bin/bash
# Runs on dreamfyre as the gha user (piped in by enrol.sh). Prepares or starts the self-hosted runner
# for one repository, copying the meteosfer runner's binaries and service unit.
# Usage: dreamfyre-runner.sh <repo> prepare|start
set -euo pipefail
R="${1:-}"; STEP="${2:-}"
[[ "$R" =~ ^[A-Za-z0-9._-]+$ && "$R" != .* ]] || { echo "bad repo name" >&2; exit 1; }
cd ~/runners
case "$STEP" in
  prepare)
    if [ -e "$R" ]; then echo "$HOME/runners/$R already exists"; exit 0; fi
    mkdir "$R"
    # Binaries and scripts only; the registration (.runner, .credentials*), work and log folders stay with meteosfer.
    (cd meteosfer && tar cf - --exclude=./.runner --exclude=./.runner_migrated --exclude='./.credentials*' \
      --exclude=./_work --exclude=./_diag --exclude=./.path .) | (cd "$R" && tar xf -)
    echo "prepared $HOME/runners/$R"
    ;;
  start)
    [ -f "$R/.runner" ] || { echo "$HOME/runners/$R is not registered" >&2; exit 1; }
    # config.sh rewrites .env; rootless Docker needs DOCKER_HOST back.
    grep -q '^DOCKER_HOST=' "$R/.env" || grep '^DOCKER_HOST=' meteosfer/.env >> "$R/.env"
    unit=~/.config/systemd/user/actions-runner-$R.service
    sed -e "s|runners/meteosfer|runners/$R|g" -e "s|(poweruserz/meteosfer)|(poweruserz/$R)|" \
      ~/.config/systemd/user/actions-runner-meteosfer.service > "$unit"
    systemctl --user daemon-reload
    systemctl --user enable --now "actions-runner-$R.service" 2>/dev/null
    systemctl --user is-active "actions-runner-$R.service"
    ;;
  *) echo "usage: dreamfyre-runner.sh <repo> prepare|start" >&2; exit 1 ;;
esac
