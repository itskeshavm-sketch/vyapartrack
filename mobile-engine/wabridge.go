// Package wabridge is the gomobile-compatible bridge between the VyaparTrack
// Android app and WhatsApp via whatsmeow.
//
// GOMOBILE CONSTRAINTS (do not violate in exported signatures):
//   - only types from this package are exported to Java
//   - no maps, chans, or slices in exported signatures (byte slices are OK)
//   - errors are returned as the last value: (result, error)
//
// Java usage (generated classes live in the `wabridge` Java package):
//
//	Wabridge.setHandler(handler);          // handler implements wabridge.Handler
//	Wabridge.startClient(filesDir + "/whatsapp");
//	String code = Wabridge.requestPairCode("919876543210");
//	Wabridge.sendText(jid, text);
package wabridge

import "errors"

// Handler is implemented by the Java layer to receive engine events.
// All callbacks are invoked on background goroutines - the Java side must
// not block them longer than a few seconds (heavy work: hop to a thread).
type Handler interface {
	// OnMessage is called for every incoming text message.
	// Payload: {"chatJid","senderJid","sender","pushName","text","msgId","timestamp","isGroup","fromMe"}
	OnMessage(jsonPayload string)
	// OnStatus is called whenever the connection state changes.
	// Payload: {"linked","connected","connecting","pairing","lastError","meJid"}
	OnStatus(jsonStatus string)
	// OnLog receives engine + whatsmeow protocol logs (one line per call),
	// e.g. "[DEBUG/wabridge-pair] Recv <notification ...>". Java forwards
	// these to logcat (tag GoLog). Only present in diagnostic builds - filter
	// by level prefix there.
	OnLog(line string)
}

// ErrNotStarted is returned when the engine has not been started yet.
var ErrNotStarted = errors.New("engine not started: call StartClient first")

// StartClient initializes the WhatsApp session store under dataDir and, if a
// paired session already exists, connects and starts listening for messages.
// If no session exists it does nothing further - call RequestPairCode to link.
// Safe to call again (no-op if already started).
func StartClient(dataDir string) error {
	return global.start(dataDir)
}

// RequestPairCode mints an 8-character pairing code for the given phone
// number (digits, with or without country code). The connection stays open so
// WhatsApp can deliver PairSuccess when the code is entered on the phone.
// WhatsApp rate-limits repeated minting (429 rate-overlimit) - surface the
// error and let the user retry manually, never auto-retry.
func RequestPairCode(phone string) (string, error) {
	return global.requestPairCode(phone)
}

// SendText sends a plain text message to the given JID
// (e.g. "919876543210@s.whatsapp.net").
func SendText(jid string, text string) error {
	return global.sendText(jid, text)
}

// SetHandler registers the native event callback. Replaces any previous
// handler. The current status is emitted immediately on the same call.
func SetHandler(h Handler) error {
	return global.setHandler(h)
}

// Status returns a JSON snapshot of the connection state.
func Status() string {
	return global.statusJSON()
}

// IsLinked reports whether a paired session exists in the local store.
func IsLinked() bool {
	return global.isLinked()
}

// IsConnected reports whether the WebSocket is currently open and logged in.
func IsConnected() bool {
	return global.isConnected()
}

// Unlink wipes the stored session (the phone-side "unlink device" flow).
// The next StartClient/RequestPairCode starts from a clean slate.
func Unlink() error {
	return global.unlink()
}

// Stop disconnects and tears the engine down.
func Stop() error {
	global.stop()
	return nil
}
