// Package hub is the browser side of tmuxde: the HTTP server, WebSocket
// lifecycle, auth and throttle, origin checks, authorization rules, access
// log, dictation client, headers and redirects.
//
// The hub reaches tmux, files and repositories only through node.Node. It
// passes decoded client messages in and receives server messages through a
// bounded node.Sink. Tokens, origins and HTTP requests stay here and never
// cross into the node. Standalone mode runs one hub and one local node in
// a single process.
//
// Sub packages:
//
//   - edge: root HTTP handler. Security headers, /health, OPTIONS, old
//     code entry redirects and the dev proxy or static web app.
//   - ws: the /_relay WebSocket. Origin check, caps, auth, rate limit,
//     liveness, idle reaper, routing to the node and shutdown.
//   - auth: token compare and per address auth backoff.
//   - conns: registry of open connections, caps and serial work queues.
//   - accesslog: connect and disconnect lines in access.log.
//   - useragent: short device labels from User-Agent.
package hub
