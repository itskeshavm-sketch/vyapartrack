# mobile-engine — on-phone WhatsApp engine (whatsmeow + gomobile)

Go module `vyapartrack/wabridge`. `gomobile bind` produces the `.aar` whose
classes/native libs are embedded in the Android app (`android/app/libs/wabridge-classes.jar`
+ `android/app/src/main/jniLibs/`).

## Public API (Java: `wabridge.Wabridge` + `wabridge.Handler`)

| Go | Java |
|---|---|
| `StartClient(dataDir)` | `Wabridge.startClient(String)` |
| `RequestPairCode(phone)` | `Wabridge.requestPairCode(String)` → code |
| `SendText(jid, text)` | `Wabridge.sendText(String, String)` |
| `SetHandler(h)` | `Wabridge.setHandler(wabridge.Handler)` |
| `Status()` / `IsLinked()` / `IsConnected()` | `status()` / `isLinked()` / `isConnected()` |
| `Unlink()` / `Stop()` | `unlink()` / `stop()` |

`Handler` (implemented by `EngineHandler.java`): `onMessage(json)`, `onStatus(json)`.

## Rebuild the .aar (Windows)

```powershell
# 1. Sync module to a space-free path (gomobile/Windows + spaces = trouble)
Copy-Item -Recurse "<repo>\mobile-engine" "C:\gomobuild\wabridge"

# 2. Bind
cmd /c "set JAVA_HOME=C:\Program Files\Android\Android Studio\jbr&& set PATH=C:\Program Files\Android\Android Studio\jbr\bin;C:\Users\DELL\go\bin;%PATH%&& set ANDROID_HOME=C:\Users\DELL\AppData\Local\Android\Sdk&& set ANDROID_NDK_HOME=C:\Users\DELL\AppData\Local\Android\Sdk\ndk\26.1.10909125&& gomobile bind -target=android -androidapi 24 -ldflags=-s -o wabridge.aar ."
# (run in C:\gomobuild\wabridge; if it errors "requires golang.org/x/mobile": go get -tool golang.org/x/mobile/cmd/gobind@latest)

# 3. Extract into the app (classes + native libs; flatDir is banned by settings.gradle)
#    unzip wabridge.aar -> classes.jar -> android/app/libs/wabridge-classes.jar
#    unzip wabridge.aar -> jni/*       -> android/app/src/main/jniLibs/*
```

## Stack notes

- `github.com/glebarez/go-sqlite` (pure Go, modernc-based) — zero cgo/NDK compile.
- Raw DB path + explicit `PRAGMA foreign_keys=ON` before `container.Upgrade()`
  (pattern proven by avikalpg/whatsapp-ai-filter `packages/wabridge`).
- Pairing: connect → `PairPhone(ctx, phone, true, PairClientChrome, "Chrome (Linux)")`
  → keep socket open → `events.PairSuccess` → `events.Connected` → live.
- Reconnect loop 5s→300s cap; on `events.LoggedOut` the device row is wiped.
- LID masking: prefers `Info.SenderAlt` / `Info.RecipientAlt` when the jid is
  not `@s.whatsapp.net` (same fix as the zapo engines).
- **Logs**: whatsmeow logs are forwarded to `Handler.onLog` (tag `GoLog` in
  logcat). `waLog.Stdout` is invisible on Android — do not use it here.

## The local whatsmeow fork (PAIRING FIX)

`go.mod` in the build copy carries:
`replace go.mau.fi/whatsmeow => C:/gomobuild/whatsmeow-fork`

Fork = module-cache copy of `v0.0.0-20260909164725` + a 2-file patch:

1. `pair-code.go` — `phoneLinkingCache` gains `advSecret []byte`; set to the
   code-derived ADV secret at `companion_finish` time.
2. `pair.go` (`handlePair`) — the pair-success HMAC is validated against the
   cached registration-time secret instead of `Store.AdvSecretKey`.

WHY: if WhatsApp sends `companion_reg_refresh` between `companion_finish` and
`pair-success`, upstream `rotateADVSecret()` replaces `Store.AdvSecretKey`
with random bytes and pair-success then fails with 401 hmac-mismatch. zapo-js
(pairs fine) keeps the registration-time secret separately — same idea here.
`SynchronousAck = true` is set on the pairing client so the refresh ack is
sent after the rotation handler runs (zapo's rotate-before-ack ordering).

If upstream whatsmeow fixes pairing, delete the `replace` line and rebuild.

