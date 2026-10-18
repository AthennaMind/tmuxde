# Runs inside server-dev. Demo repositories, dotfiles and a tmux theme for the
# dev user. Everything lives in the dev-home volume and is disposable.
set -e
export GIT_AUTHOR_NAME="Dev" GIT_AUTHOR_EMAIL="dev@example.com" GIT_COMMITTER_NAME="Dev" GIT_COMMITTER_EMAIL="dev@example.com"
export PATH=/go/bin:/usr/local/go/bin:$PATH
mkdir -p /home/dev/projects
cd /home/dev/projects
rm -rf orders-api orders-web infra
mkdir -p orders-api orders-web infra
if [ ! -d tmux/.git ]; then
  git clone -q --depth 400 https://github.com/tmux/tmux.git tmux
fi
# ---------- orders-api (Go) ----------
cd /home/dev/projects/orders-api
git init -q -b main
cat > go.mod <<'EOF'
module example.com/orders-api

go 1.24
EOF
cat > main.go <<'EOF'
package main

import (
	"log"
	"net/http"

	"example.com/orders-api/internal/handlers"
	"example.com/orders-api/internal/store"
)

func main() {
	db := store.NewMemory()
	mux := http.NewServeMux()
	mux.Handle("/orders", handlers.ListOrders(db))
	mux.Handle("/orders/", handlers.GetOrder(db))
	log.Println("orders-api listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}
EOF
mkdir -p internal/handlers internal/store
cat > internal/store/memory.go <<'EOF'
package store

import "sync"

type Order struct {
	ID     string  `json:"id"`
	Total  float64 `json:"total"`
	Status string  `json:"status"`
}

type Memory struct {
	mu     sync.RWMutex
	orders map[string]Order
}

func NewMemory() *Memory {
	return &Memory{orders: map[string]Order{}}
}

func (m *Memory) List() []Order {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Order, 0, len(m.orders))
	for _, o := range m.orders {
		out = append(out, o)
	}
	return out
}

func (m *Memory) Get(id string) (Order, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	o, ok := m.orders[id]
	return o, ok
}
EOF
cat > internal/handlers/orders.go <<'EOF'
package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"example.com/orders-api/internal/store"
)

func ListOrders(db *store.Memory) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(db.List())
	})
}

func GetOrder(db *store.Memory) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/orders/")
		o, ok := db.Get(id)
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(o)
	})
}
EOF
cat > README.md <<'EOF'
# orders-api

Small HTTP service that serves orders.

## Run

    go run .
EOF
cat > Makefile <<'EOF'
.PHONY: run test
run:
	go run .
test:
	go test ./...
EOF
git add -A && git commit -q -m "feat: bootstrap orders service"
cat > internal/handlers/health.go <<'EOF'
package handlers

import "net/http"

func Health() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
}
EOF
git add -A && git commit -q -m "feat(handlers): add health endpoint"
sed -i 's/log.Println("orders-api listening on :8080")/log.Println("orders-api listening on :8080")\n\tmux.Handle("\/health", handlers.Health())/' main.go
git add -A && git commit -q -m "fix(main): mount health handler"
cat > internal/store/memory_test.go <<'EOF'
package store

import "testing"

func TestGetMissing(t *testing.T) {
	m := NewMemory()
	if _, ok := m.Get("nope"); ok {
		t.Fatal("expected missing order")
	}
}
EOF
git add -A && git commit -q -m "test(store): cover missing order lookup"
git checkout -q -b feature/order-webhooks
mkdir -p internal/webhooks
cat > internal/webhooks/dispatch.go <<'EOF'
package webhooks

import (
	"bytes"
	"encoding/json"
	"net/http"
)

type Event struct {
	Type    string `json:"type"`
	OrderID string `json:"order_id"`
}

func Dispatch(url string, ev Event) error {
	body, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	resp, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	return resp.Body.Close()
}
EOF
git add -A && git commit -q -m "feat(webhooks): dispatch order events"
# uncommitted work
cat >> internal/handlers/orders.go <<'EOF'

func CreateOrder(db *store.Memory) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var o store.Order
		if err := json.NewDecoder(r.Body).Decode(&o); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusCreated)
	})
}
EOF
cat >> README.md <<'EOF'

## Webhooks

Set `ORDERS_WEBHOOK_URL` to receive `order.created` events.
EOF
cat > internal/webhooks/dispatch_test.go <<'EOF'
package webhooks

import "testing"

func TestDispatchBadURL(t *testing.T) {
	if err := Dispatch("http://127.0.0.1:1", Event{Type: "order.created"}); err == nil {
		t.Fatal("expected connection error")
	}
}
EOF

# ---------- orders-web (TypeScript) ----------
cd /home/dev/projects/orders-web
git init -q -b main
cat > package.json <<'EOF'
{
  "name": "orders-web",
  "private": true,
  "version": "0.3.0",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "vite": "^7.0.0",
    "vitest": "^3.2.0"
  }
}
EOF
cat > index.html <<'EOF'
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Orders</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
EOF
mkdir -p src/components src/api
cat > src/main.tsx <<'EOF'
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
EOF
cat > src/App.tsx <<'EOF'
import { OrderList } from "./components/OrderList";

export function App() {
  return (
    <main>
      <h1>Orders</h1>
      <OrderList />
    </main>
  );
}
EOF
cat > src/api/client.ts <<'EOF'
export type Order = { id: string; total: number; status: string };

export async function fetchOrders(): Promise<Order[]> {
  const res = await fetch("/orders");
  if (!res.ok) throw new Error(`orders: ${res.status}`);
  return res.json();
}
EOF
cat > src/components/OrderList.tsx <<'EOF'
import { useEffect, useState } from "react";
import { fetchOrders, type Order } from "../api/client";

export function OrderList() {
  const [orders, setOrders] = useState<Order[]>([]);
  useEffect(() => {
    fetchOrders().then(setOrders);
  }, []);
  return (
    <ul>
      {orders.map((o) => (
        <li key={o.id}>
          {o.id} {o.total.toFixed(2)} {o.status}
        </li>
      ))}
    </ul>
  );
}
EOF
cat > README.md <<'EOF'
# orders-web

React front end for orders-api.
EOF
git add -A && git commit -q -m "feat: scaffold orders web app"
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true
  },
  "include": ["src"]
}
EOF
git add -A && git commit -q -m "chore: add strict tsconfig"
cat > src/components/StatusBadge.tsx <<'EOF'
export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}
EOF
git add -A && git commit -q -m "feat(components): add StatusBadge"
# uncommitted work
cat > src/hooks/useOrders.ts 2>/dev/null || mkdir -p src/hooks
cat > src/hooks/useOrders.ts <<'EOF'
import { useEffect, useState } from "react";
import { fetchOrders, type Order } from "../api/client";

export function useOrders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchOrders().then(setOrders).catch((e) => setError(String(e)));
  }, []);
  return { orders, error };
}
EOF
cat > src/components/OrderList.tsx <<'EOF'
import { useOrders } from "../hooks/useOrders";
import { StatusBadge } from "./StatusBadge";

export function OrderList() {
  const { orders, error } = useOrders();
  if (error) return <p role="alert">{error}</p>;
  return (
    <ul>
      {orders.map((o) => (
        <li key={o.id}>
          <code>{o.id}</code> {o.total.toFixed(2)} <StatusBadge status={o.status} />
        </li>
      ))}
    </ul>
  );
}
EOF
sed -i 's/<h1>Orders<\/h1>/<h1>Orders<\/h1>\n      <p>Live view of orders-api<\/p>/' src/App.tsx

# ---------- infra (clean) ----------
cd /home/dev/projects/infra
git init -q -b main
mkdir -p compose k8s
cat > compose/docker-compose.yml <<'EOF'
services:
  api:
    image: ghcr.io/example/orders-api:0.4.1
    ports: ["8080:8080"]
  web:
    image: ghcr.io/example/orders-web:0.3.0
    ports: ["3000:80"]
EOF
cat > k8s/deployment.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-api
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: api
          image: ghcr.io/example/orders-api:0.4.1
EOF
git add -A && git commit -q -m "chore: add compose and k8s manifests"
cat >> compose/docker-compose.yml <<'EOF'
  db:
    image: postgres:17
EOF
git add -A && git commit -q -m "feat(compose): add postgres"

# ---------- dotfiles ----------
cat > /home/dev/.bashrc <<'EOT'
export PATH=/go/bin:/usr/local/go/bin:$PATH
case $- in *i*) ;; *) return ;; esac
PS1='\[\e[1;32m\]dev\[\e[0m\] \[\e[1;34m\]\w\[\e[0m\] \[\e[1;35m\]❯\[\e[0m\] '
alias ls='ls --color=auto'
export EDITOR=vi
EOT
printf '[ -f ~/.bashrc ] && . ~/.bashrc\n' > /home/dev/.bash_profile
cat > /home/dev/.tmux.conf <<'EOT'
set -g default-shell /bin/bash
set -g default-size 200x50
set -g default-terminal "tmux-256color"
set -ga terminal-overrides ",xterm-256color:Tc"
set -g mouse on
set -g history-limit 20000
set -g status-interval 5
set -g status-style "bg=#181825 fg=#cdd6f4"
set -g status-left " #S "
set -g status-left-style "bg=#89b4fa fg=#11111b bold"
set -g status-left-length 20
set -g status-right " %H:%M "
set -g status-right-style "bg=#313244 fg=#cdd6f4"
set -g window-status-format " #I #W "
set -g window-status-current-format " #I #W "
set -g window-status-current-style "bg=#313244 fg=#f5e0dc bold"
set -g pane-border-style "fg=#45475a"
set -g pane-active-border-style "fg=#89b4fa"
set -g message-style "bg=#313244 fg=#cdd6f4"
EOT
for r in orders-api orders-web infra tmux; do echo "== $r"; git -C /home/dev/projects/$r status --short --branch | head -4; done
