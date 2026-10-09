package wabridge

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	_ "github.com/glebarez/go-sqlite" // pure-Go SQLite driver (registers "sqlite")
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type statusState struct {
	Linked     bool   `json:"linked"`
	Connected  bool   `json:"connected"`
	Connecting bool   `json:"connecting"`
	Pairing    bool   `json:"pairing"`
	LastError  string `json:"lastError"`
	MeJid      string `json:"meJid"`
}

type engine struct {
	mu        sync.Mutex
	container *sqlstore.Container
	client    *whatsmeow.Client
	dataDir   string
	st        statusState
	retries   int
	stopped   bool
	started   bool
	// Pairing-code cache: a re-tap within 60s returns the same code instead of
	// re-minting (re-minting invalidates a code the user may be typing).
	lastPairCode string
	lastPairAt   time.Time
}

var global = &engine{}

// handlerRef is separate from the engine mutex ON PURPOSE: whatsmeow logs
// through logForwarder while engine methods hold e.mu (e.g. during the whole
// PairPhone round-trip). If the forwarder took e.mu, the first log line under
// the lock would self-deadlock and every mint request would hang forever.
var handlerRef atomic.Value // stores Handler

func currentHandler() Handler {
	h, _ := handlerRef.Load().(Handler)
	return h
}

// ---------------------------------------------------------------------------
// Log forwarding (whatsmeow logs -> Handler.OnLog -> logcat)
// ---------------------------------------------------------------------------

// logForwarder implements waLog.Logger and forwards every line to the Java
// handler. whatsmeow's own waLog.Stdout writes to Go's stdout, which is
// invisible on Android - without this, pairing diagnostics are blind.
type logForwarder struct {
	module string
	level  int // 0=debug 1=info 2=warn 3=error
}

func (l *logForwarder) log(level int, name string, format string, args ...interface{}) {
	if level < l.level {
		return
	}
		h := currentHandler()
	if h == nil {
		return
	}
	msg := fmt.Sprintf(format, args...)
	h.OnLog(fmt.Sprintf("[%s/%s] %s", name, l.module, msg))
}

func (l *logForwarder) Errorf(format string, args ...interface{}) { l.log(3, "ERROR", format, args...) }
func (l *logForwarder) Warnf(format string, args ...interface{})  { l.log(2, "WARN", format, args...) }
func (l *logForwarder) Infof(format string, args ...interface{})  { l.log(1, "INFO", format, args...) }
func (l *logForwarder) Debugf(format string, args ...interface{}) {
	l.log(0, "DEBUG", format, args...)
}
func (l *logForwarder) Sub(module string) waLog.Logger {
	return &logForwarder{module: l.module + "/" + module, level: l.level}
}

// ---------------------------------------------------------------------------
// Public impl
// ---------------------------------------------------------------------------

func (e *engine) start(dataDir string) error {
	e.mu.Lock()
	if e.started {
		e.mu.Unlock()
		return nil
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		e.mu.Unlock()
		return fmt.Errorf("cannot create data dir: %w", err)
	}
	e.dataDir = dataDir
	e.stopped = false

	// Raw path on purpose (no "file:" URI) + explicit PRAGMA: proven pattern
	// for Android gomobile builds (see whatsapp-ai-filter bridge/client.go).
	dbPath := filepath.Join(dataDir, "zapo.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		e.mu.Unlock()
		return fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	ctx := context.Background()
	if _, err = db.ExecContext(ctx, "PRAGMA foreign_keys = ON"); err != nil {
		_ = db.Close()
		e.mu.Unlock()
		return fmt.Errorf("sqlite pragma: %w", err)
	}
	container := sqlstore.NewWithDB(db, "sqlite", &logForwarder{module: "wabridge-store", level: 1})
	if err = container.Upgrade(ctx); err != nil {
		_ = db.Close()
		e.mu.Unlock()
		return fmt.Errorf("upgrade whatsmeow store: %w", err)
	}
	e.container = container
	e.started = true
	e.mu.Unlock()

	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		return fmt.Errorf("load device: %w", err)
	}
	if device != nil && device.ID != nil {
		// Existing session: go live immediately (background goroutine).
		go e.goLive(device)
	} else {
		e.emit()
	}
	return nil
}

func (e *engine) requestPairCode(phoneRaw string) (string, error) {
	e.mu.Lock()
	if !e.started || e.container == nil {
		e.mu.Unlock()
		return "", ErrNotStarted
	}
	phone := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, strings.TrimSpace(phoneRaw))
	if len(phone) < 11 {
		e.mu.Unlock()
		return "", fmt.Errorf("invalid phone number (need country code + number)")
	}

	if e.client != nil && e.client.IsLoggedIn() {
		e.mu.Unlock()
		return "", fmt.Errorf("already paired - unlink first to re-link")
	}

	// Same code minted <60s ago -> hand it back (a re-tap must not invalidate
	// a code the user may be entering).
	if e.st.Pairing && e.lastPairCode != "" && time.Since(e.lastPairAt) < 60*time.Second {
		code := e.lastPairCode
		e.mu.Unlock()
		return code, nil
	}

	ctx := context.Background()
	dev, err := e.container.GetFirstDevice(ctx)
	if err != nil {
		e.mu.Unlock()
		return "", fmt.Errorf("load device: %w", err)
	}
	if dev == nil || dev.ID != nil {
		// Pairing always starts from a fresh (empty) device.
		dev = e.container.NewDevice()
	}

	if e.client == nil || e.client.Store != dev {
		if e.client != nil {
			e.client.Disconnect()
		}
		e.client = whatsmeow.NewClient(dev, &logForwarder{module: "wabridge-pair", level: 0})
		e.client.AddEventHandler(e.handleEvent)
	}
	// Rotate-before-ack ordering (like zapo-js): with SynchronousAck the
	// companion_reg_refresh ack is only sent after its handler (which rotates
	// the ADV secret) has returned.
	e.client.SynchronousAck = true
	if err := e.client.Connect(); err != nil {
		e.mu.Unlock()
		return "", fmt.Errorf("connect for pairing: %w", err)
	}
	// whatsmeow docs: settle briefly after Connect before PairPhone.
	time.Sleep(1200 * time.Millisecond)

	code, err := e.client.PairPhone(ctx, phone, true, whatsmeow.PairClientChrome, "Chrome (Linux)")
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "rate-overlimit") || strings.Contains(msg, "429") {
			e.st.LastError = "rate-overlimit"
			e.st.Pairing = false
			e.unlockEmit()
			return "", fmt.Errorf("WhatsApp is rate-limiting pairing for this number - wait a few days WITHOUT retrying (every attempt resets the cooldown)")
		}
		e.st.LastError = msg
		e.unlockEmit()
		return "", fmt.Errorf("pair phone: %w", err)
	}
	e.st.Pairing = true
	e.st.Connecting = true
	e.st.LastError = ""
	e.lastPairCode = code
	e.lastPairAt = time.Now()
	e.unlockEmit()
	return code, nil
}

func (e *engine) sendText(jidStr, text string) error {
	e.mu.Lock()
	c := e.client
	e.mu.Unlock()
	if c == nil || !c.IsLoggedIn() {
		return fmt.Errorf("WhatsApp is not connected")
	}
	jid, err := types.ParseJID(jidStr)
	if err != nil {
		return fmt.Errorf("bad jid: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	msg := &waE2E.Message{Conversation: proto.String(text)}
	_, err = c.SendMessage(ctx, jid, msg)
	return err
}

func (e *engine) setHandler(h Handler) error {
	e.mu.Lock()
	handlerRef.Store(h)
	e.mu.Unlock()
	if h != nil {
		h.OnStatus(e.statusJSON())
	}
	return nil
}

func (e *engine) statusJSON() string {
	e.mu.Lock()
	st := e.st
	if st.Linked && e.client != nil && e.client.Store != nil && e.client.Store.ID != nil {
		st.MeJid = e.client.Store.ID.String()
	}
	e.mu.Unlock()
	b, _ := json.Marshal(st)
	return string(b)
}

func (e *engine) isLinked() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.st.Linked
}

func (e *engine) isConnected() bool {
	e.mu.Lock()
	c := e.client
	e.mu.Unlock()
	return c != nil && c.IsConnected() && c.IsLoggedIn()
}

func (e *engine) stop() {
	e.mu.Lock()
	e.stopped = true
	c := e.client
	e.mu.Unlock()
	if c != nil {
		c.Disconnect()
	}
}

func (e *engine) unlink() error {
	e.mu.Lock()
	c := e.client
	cont := e.container
	e.client = nil
	e.st = statusState{LastError: ""}
	e.mu.Unlock()
	if c != nil {
		c.Disconnect()
	}
	if cont == nil {
		return ErrNotStarted
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	dev, err := cont.GetFirstDevice(ctx)
	if err == nil && dev != nil {
		_ = cont.DeleteDevice(ctx, dev)
	}
	e.emit()
	return nil
}

// ---------------------------------------------------------------------------
// Live connection + reconnect loop
// ---------------------------------------------------------------------------

func (e *engine) goLive(device *store.Device) {
	e.mu.Lock()
	if e.stopped {
		e.mu.Unlock()
		return
	}
	if e.client != nil {
		e.client.Disconnect()
	}
	e.client = whatsmeow.NewClient(device, &logForwarder{module: "wabridge-live", level: 0})
	e.client.AddEventHandler(e.handleEvent)
	e.st.Linked = true
	e.st.Connected = false
	e.st.Connecting = true
	e.st.Pairing = false
	e.mu.Unlock()
	e.emit()

	for {
		e.mu.Lock()
		if e.stopped {
			e.mu.Unlock()
			return
		}
		c := e.client
		e.mu.Unlock()
		if c == nil {
			return
		}

		_ = c.Connect()

		// Wait while this client stays connected; bail out when it drops,
		// the engine is stopped, or the client was replaced.
		for {
			time.Sleep(2 * time.Second)
			e.mu.Lock()
			stopped := e.stopped
			live := e.client == c && c.IsConnected()
			e.mu.Unlock()
			if stopped || !live {
				break
			}
		}

		e.mu.Lock()
		stopped := e.stopped
		stillOurs := e.client == c
		e.mu.Unlock()
		if stopped || !stillOurs {
			return
		}

		if !c.IsLoggedIn() {
			// Session dead (logout/ban) - wipe and wait for a fresh pairing.
			e.wipeSession("Session expired - link again")
			return
		}

		e.mu.Lock()
		e.retries++
		if e.retries > 6 {
			e.retries = 6
		}
		delay := time.Duration(5*(1<<(e.retries-1))) * time.Second
		if delay > 300*time.Second {
			delay = 300 * time.Second
		}
		e.st.Connected = false
		e.st.Connecting = true
		e.st.LastError = "Connection lost - reconnecting..."
		e.mu.Unlock()
		e.emit()
		time.Sleep(delay)
	}
}

func (e *engine) wipeSession(msg string) {
	e.mu.Lock()
	c := e.client
	e.client = nil
	e.st = statusState{LastError: msg}
	cont := e.container
	e.mu.Unlock()
	if c != nil {
		c.Disconnect()
	}
	if cont != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		dev, err := cont.GetFirstDevice(ctx)
		if err == nil && dev != nil {
			_ = cont.DeleteDevice(ctx, dev)
		}
		cancel()
	}
	e.emit()
}

// ---------------------------------------------------------------------------
// Event handler
// ---------------------------------------------------------------------------

func (e *engine) handleEvent(evt interface{}) {
	switch v := evt.(type) {
	case *events.Message:
		e.deliverMessage(v)
	case *events.Connected:
		e.mu.Lock()
		e.st.Connected = true
		e.st.Connecting = false
		e.st.Pairing = false
		e.st.Linked = true
		e.st.LastError = ""
		e.retries = 0
		e.mu.Unlock()
		e.emit()
	case *events.Disconnected:
		e.mu.Lock()
		e.st.Connected = false
		e.mu.Unlock()
		e.emit()
	case *events.PairSuccess:
		// Pairing handshake done; the Connected event follows after the
		// websocket re-opens, so keep Connecting=true until then.
		e.mu.Lock()
		e.st.Pairing = false
		e.st.Linked = true
		e.st.Connecting = true
		e.st.LastError = ""
		e.mu.Unlock()
		e.emit()
	case *events.PairError:
		e.mu.Lock()
		e.st.Pairing = false
		e.st.LastError = "pair error: " + v.Error.Error()
		e.mu.Unlock()
		e.emit()
	case *events.LoggedOut:
		e.wipeSession("Logged out - link again")
	case *events.StreamReplaced:
		e.mu.Lock()
		e.st.LastError = "Opened elsewhere - reconnecting"
		e.mu.Unlock()
		e.emit()
	case *events.ConnectFailure:
		e.mu.Lock()
		e.st.LastError = "connect failure: " + v.Reason.String()
		e.mu.Unlock()
		e.emit()
	case *events.KeepAliveTimeout:
		// ignore - the socket layer notices dead connections on its own
	}
}

func (e *engine) deliverMessage(v *events.Message) {
	if v.Info.IsFromMe || v.Message == nil {
		return
	}
	if v.Message.GetProtocolMessage() != nil {
		return
	}
	text := extractBody(v)
	if strings.TrimSpace(text) == "" {
		return
	}
	chat := v.Info.Chat
	sender := v.Info.Sender
	// Masked/LID addressing: prefer the real phone jid for display.
	if sender.Server != "s.whatsapp.net" && !v.Info.SenderAlt.IsEmpty() && v.Info.SenderAlt.Server == "s.whatsapp.net" {
		sender = v.Info.SenderAlt
	}
	if !v.Info.IsGroup && chat.Server != "s.whatsapp.net" && !v.Info.RecipientAlt.IsEmpty() && v.Info.RecipientAlt.Server == "s.whatsapp.net" {
		chat = v.Info.RecipientAlt
	}

	payload := map[string]interface{}{
		"chatJid":   chat.String(),
		"senderJid": sender.String(),
		"sender":    "+" + sender.User,
		"pushName":  v.Info.PushName,
		"text":      text,
		"msgId":     string(v.Info.ID),
		"timestamp": v.Info.Timestamp.Unix(),
		"isGroup":   v.Info.IsGroup,
		"fromMe":    false,
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return
	}
	e.mu.Lock()
	h := currentHandler()
	e.mu.Unlock()
	if h != nil {
		h.OnMessage(string(b))
	}
}

func extractBody(evt *events.Message) string {
	if evt.Message == nil {
		return ""
	}
	if c := evt.Message.GetConversation(); c != "" {
		return c
	}
	if ext := evt.Message.GetExtendedTextMessage(); ext != nil {
		return ext.GetText()
	}
	if img := evt.Message.GetImageMessage(); img != nil {
		return img.GetCaption()
	}
	if vid := evt.Message.GetVideoMessage(); vid != nil {
		return vid.GetCaption()
	}
	if doc := evt.Message.GetDocumentMessage(); doc != nil {
		return doc.GetCaption()
	}
	return ""
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func (e *engine) emit() {
	e.mu.Lock()
	st := e.st
	h := currentHandler()
	e.mu.Unlock()
	if h != nil {
		b, _ := json.Marshal(st)
		h.OnStatus(string(b))
	}
}

func (e *engine) unlockEmit() {
	st := e.st
	h := currentHandler()
	e.mu.Unlock()
	if h != nil {
		b, _ := json.Marshal(st)
		h.OnStatus(string(b))
	}
}
