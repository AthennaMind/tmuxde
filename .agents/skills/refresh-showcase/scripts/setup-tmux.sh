# Runs inside server-dev. Recreates the demo sessions on the dev tmux socket.
# Sessions not listed here, like the user's own, are left alone.
set -e
S=/tmp/tmuxde-dev.sock
T="tmux -S $S"
P=/home/dev/projects
$T start-server
$T source-file /home/dev/.tmux.conf
for s in agents orders-api orders-web infra work; do $T kill-session -t "=$s" 2>/dev/null || true; done
# agents: four tiled panes with TUIs and a test loop. btop needs 80 columns.
$T new-session -d -s agents -n monitor -c $P/tmux
$T split-window -h -t agents:monitor -c $P/tmux
$T split-window -v -t agents:monitor.0 -c $P/tmux
$T split-window -v -t agents:monitor.2 -c $P/tmux
$T select-layout -t agents:monitor tiled
$T resize-pane -t agents:monitor.0 -x 58%
$T send-keys -t agents:monitor.0 'btop' Enter
$T send-keys -t agents:monitor.1 'htop -d 30' Enter
$T send-keys -t agents:monitor.2 'tig' Enter
$T send-keys -t agents:monitor.3 'clear; cd /workspace && while true; do go test ./internal/protocol/... ./internal/config/... -count=1 -v 2>&1 | grep -E "^(=== RUN|--- (PASS|FAIL)|ok|FAIL)"; sleep 15; done' Enter
$T new-window -t agents -n shell -c $P
$T send-keys -t agents:shell 'clear; git -C tmux --no-pager log --stat --color -n 12' Enter
$T select-window -t agents:monitor
$T select-pane -t agents:monitor.3
# orders-api: shell with a diff and tig status. Overview cards show the bottom
# rows of a pane, so shell output must overflow the screen.
$T new-session -d -s orders-api -n api -c $P/orders-api
$T split-window -h -t orders-api:api -c $P/orders-api
$T send-keys -t orders-api:api.1 'tig status' Enter
$T send-keys -t orders-api:api.0 'clear; git --no-pager log --oneline --decorate --color -n 6; echo; git status --short --branch; echo; git --no-pager diff --color' Enter
$T select-pane -t orders-api:api.0
$T new-session -d -s orders-web -n web -c $P/orders-web
$T send-keys -t orders-web:web 'clear; git --no-pager log --graph --decorate --stat --color -n 3; echo; git status --short; echo; git --no-pager diff --color' Enter
$T new-session -d -s infra -n infra -c $P/infra
$T send-keys -t infra:infra 'vi k8s/deployment.yaml' Enter
# work: plain shell used by the cwd scene, reset again before recording.
$T new-session -d -s work -n shell -c $P
$T send-keys -t work:shell 'clear; ls --color' Enter
sleep 2
$T list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_current_command} #{pane_current_path}'
