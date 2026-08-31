// Engine entry for the Android APK. Same app as the desktop version:
// Express dashboard + Baileys bot. Env vars set by the Android host:
//   VYAPAR_DATA_DIR / VYAPAR_AUTH_DIR - user data outside the bundled engine
//   PORT - defaults to 3000
require('./src/index');
