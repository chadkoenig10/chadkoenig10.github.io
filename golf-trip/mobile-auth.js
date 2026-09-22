/* Caddie native OAuth handler (Capacitor iOS).
 *
 * Loaded only when window.Capacitor exists — the page injects this script
 * dynamically on native, so the web build never fetches it. On the web it is
 * a harmless no-op.
 *
 * Google sign-in inside the app can't use a normal browser redirect (there
 * is no page to return to), so we:
 *   1. ask supabase-js for the OAuth URL with skipBrowserRedirect: true,
 *   2. open it in the Capacitor Browser plugin (ASWebAuthenticationSession
 *      style in-app browser),
 *   3. listen for the appUrlOpen event carrying the custom-scheme callback
 *      (com.chadkoenig.caddie://login-callback?code=...),
 *   4. exchange the code for a session via the same supabase client.
 *
 * Prereqs (done once on the Mac / in dashboards):
 *   - iOS URL scheme "com.chadkoenig.caddie" registered (see mobile/README.md)
 *   - Supabase dashboard → Authentication → URL Configuration → Redirect URLs
 *     includes "com.chadkoenig.caddie://login-callback"
 */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.Capacitor) return;

  var CALLBACK_SCHEME = "com.chadkoenig.caddie://login-callback";

  function plugins() {
    var cap = window.Capacitor;
    return {
      Browser: cap.Plugins && cap.Plugins.Browser,
      App: cap.Plugins && cap.Plugins.App
    };
  }

  async function signInWithGoogle(client) {
    var p = plugins();
    if (!p.Browser || !p.App) {
      throw new Error("Capacitor Browser/App plugins are not available.");
    }
    var res = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: CALLBACK_SCHEME, skipBrowserRedirect: true }
    });
    if (res.error) throw res.error;
    var url = res.data && res.data.url;
    if (!url) throw new Error("No OAuth URL returned.");

    return new Promise(function (resolve, reject) {
      var done = false;
      var listener = null;

      function cleanup() {
        if (listener) {
          try { listener.remove(); } catch (e) { /* ignore */ }
          listener = null;
        }
      }
      function finish(err) {
        if (done) return;
        done = true;
        cleanup();
        try { p.Browser.close(); } catch (e) { /* ignore */ }
        if (err) reject(err);
        else resolve();
      }

      /* The OS routes com.chadkoenig.caddie://login-callback?code=... here. */
      p.App.addListener("appUrlOpen", function (event) {
        try {
          var u = new URL(event.url || "");
          var code = u.searchParams.get("code");
          if (!code) { finish(new Error("Sign-in was cancelled or failed.")); return; }
          client.auth.exchangeCodeForSession(code).then(function (r) {
            if (r.error) finish(r.error);
            else finish(null);
          }).catch(finish);
        } catch (e) { finish(e); }
      }).then(function (h) { listener = h; }).catch(function () { /* ignore */ });

      p.Browser.open({ url: url, windowName: "_blank", presentationStyle: "popover" })
        .catch(function (e) { finish(e); });

      /* Safety net: don't hang forever if the browser is dismissed. */
      setTimeout(function () {
        if (!done) finish(new Error("Sign-in timed out — please try again."));
      }, 120000);
    });
  }

  window.CaddieNativeAuth = {
    signInWithGoogle: signInWithGoogle,
    callbackScheme: CALLBACK_SCHEME
  };
})();
