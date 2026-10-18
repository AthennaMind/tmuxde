# Runs inside an agent container. Usage: bash -s alpha|beta
# Alpha gets a small repo with one modified file, beta runs htop.
set -e
NAME=$1
cat > /home/dev/.bashrc <<EOT
case \$- in *i*) ;; *) return ;; esac
PS1='\[\e[1;32m\]$NAME\[\e[0m\] \[\e[1;34m\]\w\[\e[0m\] \[\e[1;35m\]❯\[\e[0m\] '
alias ls='ls --color=auto'
EOT
printf '[ -f ~/.bashrc ] && . ~/.bashrc\n' > /home/dev/.bash_profile
T="tmux -S /tmp/tmuxde-agent.sock"
$T send-keys -t dev C-c "" Enter
sleep 0.3
$T send-keys -t dev "exec bash" Enter
sleep 0.5
if [ "$NAME" = alpha ]; then
  export GIT_AUTHOR_NAME="Dev" GIT_AUTHOR_EMAIL="dev@example.com" GIT_COMMITTER_NAME="Dev" GIT_COMMITTER_EMAIL="dev@example.com"
  cd /home/dev/workspace
  rm -rf edge-config && mkdir edge-config && cd edge-config
  git init -q -b main
  mkdir -p sites roles
  printf 'host: edge-01.example.net\nregion: eu-west\nroles: [caddy, node-exporter]\n' > sites/edge-01.yaml
  printf 'host: edge-02.example.net\nregion: us-east\nroles: [caddy, node-exporter]\n' > sites/edge-02.yaml
  printf 'packages: [caddy]\nservices: [caddy]\nconfig: /etc/caddy/Caddyfile\n' > roles/caddy.yaml
  printf '# edge-config\n\nInventory and roles for the edge hosts.\n' > README.md
  git add -A && git commit -q -m "chore: add edge inventory"
  printf 'packages: [prometheus-node-exporter]\nservices: [prometheus-node-exporter]\n' > roles/node-exporter.yaml
  git add -A && git commit -q -m "feat(roles): add node exporter"
  printf 'tags: [canary]\n' >> sites/edge-01.yaml
  $T send-keys -t dev "cd ~/workspace/edge-config && clear; for f in sites/*.yaml roles/*.yaml; do echo \"== \$f\"; cat \$f; echo; done; git --no-pager log --stat --color; git status --short" Enter
else
  $T send-keys -t dev "cd ~/workspace && clear; htop -d 30" Enter
fi
sleep 1
$T list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_current_command} #{pane_current_path}'
