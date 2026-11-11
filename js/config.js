/*
 * Firebase configuration for Azul online play.
 *
 * Project: azul-game-f39fb (Spark free plan) — values from FIREBASE_CONFIG.md.
 * A Firebase web config is a public client identifier, not a secret; it is
 * safe to ship in the web app. Access is gated by the Realtime Database
 * rules and the unguessable room codes.
 *
 * js/online.js still degrades gracefully: if these values are ever replaced
 * with placeholders containing "YOUR_...", or the Firebase SDK cannot load,
 * online mode disables itself with an "Online play isn't set up yet"
 * message and local games keep working.
 */
export const firebaseConfig = {
  apiKey: 'AIzaSyApjO9jWhqqy6u9u1mHaQj1xvFB_gqjYMA',
  authDomain: 'azul-game-f39fb.firebaseapp.com',
  databaseURL: 'https://azul-game-f39fb-default-rtdb.firebaseio.com',
  projectId: 'azul-game-f39fb',
  storageBucket: 'azul-game-f39fb.firebasestorage.app',
  messagingSenderId: '1033869835121',
  appId: '1:1033869835121:web:984b02e9725591aa84d4d0'
};

// Fallback for the plain-script parts of the app (js/online.js reads this).
if (typeof window !== 'undefined') {
  window.FIREBASE_CONFIG = firebaseConfig;
}
