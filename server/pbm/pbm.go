// Package pbm implements moo2v2's play-by-mail store, mounted next to the
// lobbylink lobby (which is linked in as a library — see cmd/moo2v2-server).
//
// One shared password (from a config file) gates everything; the returned
// token (its sha256) may be presented as a cookie or an X-PBM-Auth header so
// players log in once. Each room code stores an opaque save blob plus commit
// metadata, and an in-memory expiring lock ensures a single writer at a time:
// the lock holder hosts the game, later arrivals are told who is playing (so
// they can join that player's live room instead). This is coordination for
// well-behaved friends, not a security barrier beyond the shared password.
package pbm

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// FileConfig is the on-disk JSON config (--pbm-config).
type FileConfig struct {
	// Password is the shared secret every player must present once.
	Password string `json:"password"`
	// DataDir holds one subdirectory per room code.
	DataDir string `json:"data_dir"`
	// LockTTLSeconds is how long a player holds the room without renewing
	// (heartbeats renew it; a vanished player times out). Default 180.
	LockTTLSeconds int `json:"lock_ttl_seconds"`
}

// Server is the /pbm/ HTTP handler set plus its in-memory lock table.
type Server struct {
	tokenHash      []byte // sha256 of the shared password (hex string bytes)
	dataDir        string
	lockTTL        time.Duration
	allowedOrigins []string
	log            *slog.Logger
	now            func() time.Time

	mu    sync.Mutex
	locks map[string]lockInfo
}

type lockInfo struct {
	name    string
	expires time.Time
}

// Player identifies a seat in the stored game.
type Player struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

// Meta is the per-room sidecar: whose commits are outstanding this turn.
type Meta struct {
	Turn      int       `json:"turn"`
	Committed []int     `json:"committed"`
	Players   []Player  `json:"players"`
	UpdatedAt time.Time `json:"updatedAt"`
	UpdatedBy string    `json:"updatedBy"`
}

// Load reads the JSON config file and builds a Server.
func Load(path string, allowedOrigins []string, log *slog.Logger) (*Server, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("pbm config: %w", err)
	}
	var fc FileConfig
	if err := json.Unmarshal(raw, &fc); err != nil {
		return nil, fmt.Errorf("pbm config: %w", err)
	}
	if fc.Password == "" {
		return nil, errors.New("pbm config: password must be set")
	}
	if fc.DataDir == "" {
		return nil, errors.New("pbm config: data_dir must be set")
	}
	ttl := time.Duration(fc.LockTTLSeconds) * time.Second
	if ttl <= 0 {
		ttl = 180 * time.Second
	}
	if err := os.MkdirAll(fc.DataDir, 0o755); err != nil {
		return nil, fmt.Errorf("pbm data dir: %w", err)
	}
	return New(fc.Password, fc.DataDir, ttl, allowedOrigins, log), nil
}

// New builds a Server directly (tests / embedding).
func New(password, dataDir string, lockTTL time.Duration, allowedOrigins []string, log *slog.Logger) *Server {
	return &Server{
		tokenHash:      []byte(tokenFor(password)),
		dataDir:        dataDir,
		lockTTL:        lockTTL,
		allowedOrigins: allowedOrigins,
		log:            log,
		now:            time.Now,
		locks:          map[string]lockInfo{},
	}
}

// SetNow injects a clock (tests).
func (s *Server) SetNow(now func() time.Time) { s.now = now }

// tokenFor derives the login token from the shared password.
func tokenFor(password string) string {
	sum := sha256.Sum256([]byte("moo2v2-pbm:" + password))
	return hex.EncodeToString(sum[:])
}

func hashSecret(secret string) string {
	sum := sha256.Sum256([]byte("moo2v2-seat:" + secret))
	return hex.EncodeToString(sum[:])
}

// Wrap mounts the /pbm/ routes in front of next (the lobby handler).
func (s *Server) Wrap(next http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /pbm/login", s.wrapCORS(s.handleLogin))
	mux.HandleFunc("GET /pbm/rooms", s.wrapCORS(s.auth(s.handleRooms)))
	mux.HandleFunc("GET /pbm/rooms/{code}", s.wrapCORS(s.auth(s.handleRoomGet)))
	mux.HandleFunc("POST /pbm/rooms/{code}/save", s.wrapCORS(s.auth(s.handleSave)))
	mux.HandleFunc("POST /pbm/rooms/{code}/lock", s.wrapCORS(s.auth(s.handleLock)))
	mux.HandleFunc("DELETE /pbm/rooms/{code}/lock", s.wrapCORS(s.auth(s.handleUnlock)))
	mux.HandleFunc("POST /pbm/rooms/{code}/protect", s.wrapCORS(s.auth(s.handleProtect)))
	mux.HandleFunc("OPTIONS /pbm/", s.wrapCORS(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/pbm/") {
			mux.ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ----- middleware -----

func (s *Server) wrapCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Vary", "Origin")
		origin := r.Header.Get("Origin")
		if origin != "" {
			for _, o := range s.allowedOrigins {
				if o == origin {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
					w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-PBM-Auth")
					break
				}
			}
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("X-PBM-Auth")
		if token == "" {
			if c, err := r.Cookie("pbm_auth"); err == nil {
				token = c.Value
			}
		}
		if subtle.ConstantTimeCompare([]byte(token), s.tokenHash) != 1 {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "not logged in (bad or missing PBM password token)"})
			return
		}
		next(w, r)
	}
}

// ----- handlers -----

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	token := tokenFor(body.Password)
	if subtle.ConstantTimeCompare([]byte(token), s.tokenHash) != 1 {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "wrong password"})
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "pbm_auth",
		Value:    token,
		Path:     "/pbm/",
		MaxAge:   365 * 24 * 3600,
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, map[string]string{"token": token})
}

type roomSummary struct {
	Code      string    `json:"code"`
	Turn      int       `json:"turn"`
	Committed []int     `json:"committed"`
	Players   []Player  `json:"players"`
	UpdatedAt time.Time `json:"updatedAt"`
	UpdatedBy string    `json:"updatedBy"`
	Lock      *lockJSON `json:"lock"`
}

type lockJSON struct {
	Holder    string    `json:"holder"`
	ExpiresAt time.Time `json:"expiresAt"`
}

func (s *Server) handleRooms(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(s.dataDir)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	out := []roomSummary{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		meta, err := s.readMeta(e.Name())
		if err != nil {
			continue
		}
		out = append(out, roomSummary{
			Code:      e.Name(),
			Turn:      meta.Turn,
			Committed: meta.Committed,
			Players:   meta.Players,
			UpdatedAt: meta.UpdatedAt,
			UpdatedBy: meta.UpdatedBy,
			Lock:      s.lockJSON(e.Name()),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleRoomGet(w http.ResponseWriter, r *http.Request) {
	code, ok := roomCode(w, r)
	if !ok {
		return
	}
	save, err := os.ReadFile(filepath.Join(s.dataDir, code, "save.moo2save"))
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such play-by-mail room"})
		return
	}
	meta, err := s.readMeta(code)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"save":      base64.StdEncoding.EncodeToString(save),
		"meta":      meta,
		"lock":      s.lockJSON(code),
		"protected": s.protectedNames(code),
	})
}

func (s *Server) handleSave(w http.ResponseWriter, r *http.Request) {
	code, ok := roomCode(w, r)
	if !ok {
		return
	}
	var body struct {
		Name      string   `json:"name"`
		Save      string   `json:"save"`
		Turn      int      `json:"turn"`
		Committed []int    `json:"committed"`
		Players   []Player `json:"players"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<20)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json: " + err.Error()})
		return
	}
	save, err := base64.StdEncoding.DecodeString(body.Save)
	if err != nil || len(save) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad save encoding"})
		return
	}
	dir := filepath.Join(s.dataDir, code)
	// stat-and-claim under the mutex: two concurrent first-uploads for the
	// same code must not both become the creator
	s.mu.Lock()
	isNew := true
	if _, err := os.Stat(filepath.Join(dir, "save.moo2save")); err == nil {
		isNew = false
	}
	if isNew {
		if lk, ok := s.locks[code]; ok && lk.name != body.Name && s.now().Before(lk.expires) {
			holder := lk.name
			s.mu.Unlock()
			writeJSON(w, http.StatusLocked, map[string]any{"error": "another player is creating this room", "holder": holder})
			return
		}
		// creating counts as taking the lock: the creator plays first
		s.locks[code] = lockInfo{name: body.Name, expires: s.now().Add(s.lockTTL)}
	}
	s.mu.Unlock()
	// uploads require holding the lock, except the very first (room creation)
	if !isNew && !s.holdsLock(code, body.Name) {
		lk := s.lockJSON(code)
		holder := "nobody"
		if lk != nil {
			holder = lk.Holder
		}
		writeJSON(w, http.StatusLocked, map[string]any{"error": "you do not hold this room's lock", "holder": holder})
		return
	}
	if err := os.MkdirAll(filepath.Join(dir, "history"), 0o755); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// meta first, THEN the save renames into place: a crash between the two
	// must never leave a new save paired with stale meta
	meta := Meta{
		Turn:      body.Turn,
		Committed: normInts(body.Committed),
		Players:   body.Players,
		UpdatedAt: s.now().UTC(),
		UpdatedBy: body.Name,
	}
	if err := s.writeMeta(code, meta); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// atomic main copy + a turn-stamped history copy (incremental record)
	tmp := filepath.Join(dir, "save.tmp")
	if err := os.WriteFile(tmp, save, 0o644); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if err := os.Rename(tmp, filepath.Join(dir, "save.moo2save")); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	hist := filepath.Join(dir, "history", fmt.Sprintf("turn-%05d-%d.moo2save", body.Turn, s.now().UnixMilli()))
	_ = os.WriteFile(hist, save, 0o644)
	s.log.Info("pbm save", "room", code, "by", body.Name, "turn", body.Turn, "committed", meta.Committed, "bytes", len(save))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "turn": meta.Turn})
}

func (s *Server) handleLock(w http.ResponseWriter, r *http.Request) {
	code, ok := roomCode(w, r)
	if !ok {
		return
	}
	var body struct {
		Name           string `json:"name"`
		PlayerName     string `json:"playerName"`
		PlayerPassword string `json:"playerPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name required"})
		return
	}
	// seat protection: honor-level, checked for the seat they claim to play
	if body.PlayerName != "" {
		secrets := s.readSecrets(code)
		if want, has := secrets[strings.ToLower(body.PlayerName)]; has {
			if subtle.ConstantTimeCompare([]byte(hashSecret(body.PlayerPassword)), []byte(want)) != 1 {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "that player is protected by a password"})
				return
			}
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if lk, held := s.locks[code]; held && lk.expires.After(now) && lk.name != body.Name {
		writeJSON(w, http.StatusLocked, map[string]any{
			"error":     fmt.Sprintf("%s is playing this room right now — join their live game or try later", lk.name),
			"holder":    lk.name,
			"expiresAt": lk.expires.UTC(),
		})
		return
	}
	lk := lockInfo{name: body.Name, expires: now.Add(s.lockTTL)}
	s.locks[code] = lk
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "expiresAt": lk.expires.UTC()})
}

func (s *Server) handleUnlock(w http.ResponseWriter, r *http.Request) {
	code, ok := roomCode(w, r)
	if !ok {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	s.mu.Lock()
	if lk, held := s.locks[code]; held && lk.name == body.Name {
		delete(s.locks, code)
	}
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleProtect(w http.ResponseWriter, r *http.Request) {
	code, ok := roomCode(w, r)
	if !ok {
		return
	}
	var body struct {
		PlayerName  string `json:"playerName"`
		Password    string `json:"password"`
		OldPassword string `json:"oldPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.PlayerName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "playerName required"})
		return
	}
	key := strings.ToLower(body.PlayerName)
	secrets := s.readSecrets(code)
	if want, has := secrets[key]; has {
		if subtle.ConstantTimeCompare([]byte(hashSecret(body.OldPassword)), []byte(want)) != 1 {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "wrong current password for that player"})
			return
		}
	}
	if body.Password == "" {
		delete(secrets, key)
	} else {
		secrets[key] = hashSecret(body.Password)
	}
	if err := s.writeSecrets(code, secrets); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ----- storage helpers -----

var codeRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

func roomCode(w http.ResponseWriter, r *http.Request) (string, bool) {
	code := r.PathValue("code")
	if !codeRe.MatchString(code) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad room code"})
		return "", false
	}
	return code, true
}

func (s *Server) readMeta(code string) (Meta, error) {
	raw, err := os.ReadFile(filepath.Join(s.dataDir, code, "meta.json"))
	if err != nil {
		return Meta{}, err
	}
	var m Meta
	if err := json.Unmarshal(raw, &m); err != nil {
		return Meta{}, err
	}
	if m.Committed == nil {
		m.Committed = []int{}
	}
	return m, nil
}

func (s *Server) writeMeta(code string, m Meta) error {
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Join(s.dataDir, code)
	tmp := filepath.Join(dir, "meta.tmp")
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, "meta.json"))
}

func (s *Server) readSecrets(code string) map[string]string {
	out := map[string]string{}
	raw, err := os.ReadFile(filepath.Join(s.dataDir, code, "secrets.json"))
	if err == nil {
		_ = json.Unmarshal(raw, &out)
	}
	return out
}

func (s *Server) writeSecrets(code string, secrets map[string]string) error {
	dir := filepath.Join(s.dataDir, code)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	raw, err := json.Marshal(secrets)
	if err != nil {
		return err
	}
	// temp+rename: a crash mid-write must not drop every seat protection
	tmp := filepath.Join(dir, "secrets.tmp")
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, "secrets.json"))
}

func (s *Server) protectedNames(code string) []string {
	names := []string{}
	for k := range s.readSecrets(code) {
		names = append(names, k)
	}
	return names
}

func (s *Server) lockJSON(code string) *lockJSON {
	s.mu.Lock()
	defer s.mu.Unlock()
	lk, held := s.locks[code]
	if !held || !lk.expires.After(s.now()) {
		return nil
	}
	return &lockJSON{Holder: lk.name, ExpiresAt: lk.expires.UTC()}
}

func (s *Server) holdsLock(code, name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	lk, held := s.locks[code]
	return held && lk.name == name && lk.expires.After(s.now())
}

func normInts(in []int) []int {
	if in == nil {
		return []int{}
	}
	return in
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
