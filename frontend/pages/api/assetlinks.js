// Digital Asset Links for the Android app (served at
// /.well-known/assetlinks.json via the rewrite in next.config.js).
//
// Android only opens the app full-screen, without a browser address bar,
// when this site vouches for the app's signing key. PWABuilder gives you
// both values when it builds the app; set them in Vercel:
//   ANDROID_PACKAGE        e.g. app.vercel.coal_gov_sih.twa
//   ANDROID_SHA256         the SHA-256 fingerprint, AA:BB:...; several may
//                          be given, comma-separated (e.g. your key and
//                          Google Play's app-signing key)
export default function handler(req, res) {
  const pkg = (process.env.ANDROID_PACKAGE || "").trim();
  const prints = (process.env.ANDROID_SHA256 || "").split(",").map((s) => s.trim()).filter(Boolean);
  const body = pkg && prints.length
    ? [{
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: prints },
      }]
    : [];
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).send(JSON.stringify(body, null, 2));
}
