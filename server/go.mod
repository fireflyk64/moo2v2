module github.com/danielrh/moo2v2/server

go 1.26.4

require github.com/danielrh/lobbylink v0.0.0

require github.com/coder/websocket v1.8.15 // indirect

// lobbylink is linked in as a library (sibling checkout; see README):
//   ~/dev/moo2v2/server  ->  ~/dev/lobbylink
replace github.com/danielrh/lobbylink => ../../lobbylink
