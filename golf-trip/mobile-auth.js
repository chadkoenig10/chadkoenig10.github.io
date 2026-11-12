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

  /* Never surface raw JS-engine text in the login UI (e.g. ".then is not a
   * function. (In 'p.App.addListener(...)')") — it reads as gibberish.
   * Map engine/network-level failures to a human message; pass through
   * genuine auth errors (cancelled, provider errors) untouched. */
  function friendlySignInError(provider, err) {
    var label = provider === "apple" ? "Apple" : "Google";
    var msg = (err && err.message) || String(err || "");
    if (/is not a function|undefined is not an object|cannot read propert|can't find variable|failed to fetch|networkerror|load failed/i.test(msg)) {
      return new Error(label + " sign-in couldn't start — check your connection and try again.");
    }
    return err instanceof Error ? err : new Error(msg || (label + " sign-in failed — try again."));
  }

  async function signInWithProvider(client, provider) {
    var p = plugins();
    if (!p.Browser || !p.App) {
      throw new Error("Capacitor Browser/App plugins are not available.");
    }
    var res = await client.auth.signInWithOAuth({
      provider: provider,
      options: { redirectTo: CALLBACK_SCHEME, skipBrowserRedirect: true }
    });
    if (res.error) throw res.error;
    var url = res.data && res.data.url;
    if (!url) throw new Error("No OAuth URL returned.");

    /* A synchronous throw anywhere below (e.g. a plugin proxy throwing on
     * addListener) auto-rejects the promise with the raw error — map it so
     * the login UI never shows engine gibberish. Errors already routed
     * through finish() are friendly and pass through unchanged. */
    try {
      return await new Promise(function (resolve, reject) {
      var done = false;
      var listener = null;        /* resolved PluginListenerHandle */
      var listenerPending = null; /* promise for the handle, when async */

      function cleanup() {
        if (listenerPending) {
          listenerPending.then(function (h) { try { h.remove(); } catch (e) { /* ignore */ } },
                               function () { /* ignore */ });
          listenerPending = null;
        }
        if (listener) {
          try {
            var r = listener.remove();
            if (r && typeof r.then === "function") r.catch(function () { /* ignore */ });
          } catch (e) { /* ignore */ }
          listener = null;
        }
      }
      function finish(err) {
        if (done) return;
        done = true;
        cleanup();
        try { p.Browser.close(); } catch (e) { /* ignore */ }
        if (err) reject(friendlySignInError(provider, err));
        else resolve();
      }

      /* The OS routes com.chadkoenig.caddie://login-callback?code=... here.
       *
       * NOTE (2026-09-25): the raw window.Capacitor.Plugins proxy used here
       * resolves the listener handle SYNCHRONOUSLY, while the @capacitor/app
       * package types addListener() as returning a Promise. Chaining .then()
       * unconditionally crashed native Apple/Google sign-in on device with
       * ".then is not a function". Handle both shapes. */
      var handle = p.App.addListener("appUrlOpen", function (event) {
        try {
          var rawUrl = event.url || "";
          var u = new URL(rawUrl);
          var code = u.searchParams.get("code");
          var errParam = u.searchParams.get("error") || u.searchParams.get("error_code");
          var errDesc = u.searchParams.get("error_description");
          if (errParam) {
            finish(new Error("Sign-in failed: " + errParam + (errDesc ? " — " + errDesc : "")));
            return;
          }
          if (code) {
            /* PKCE flow: exchange the code for a session. */
            client.auth.exchangeCodeForSession(code).then(function (r) {
              if (r.error) finish(r.error);
              else finish(null);
            }).catch(finish);
            return;
          }
          /* Implicit flow: Supabase returned tokens in the URL fragment
           * (#access_token=...&refresh_token=...). Set the session directly. */
          var fragParams = {};
          try {
            var frag = (u.hash || "").replace(/^#/, "");
            frag.split("&").forEach(function (pair) {
              var idx = pair.indexOf("=");
              if (idx > 0) fragParams[pair.slice(0, idx)] = decodeURIComponent(pair.slice(idx + 1));
            });
          } catch (e) { /* ignore */ }
          if (fragParams.error) {
            finish(new Error("Sign-in failed: " + fragParams.error + (fragParams.error_description ? " — " + fragParams.error_description : "")));
            return;
          }
          if (fragParams.access_token) {
            client.auth.setSession({
              access_token: fragParams.access_token,
              refresh_token: fragParams.refresh_token || ""
            }).then(function (r) {
              if (r.error) finish(r.error);
              else finish(null);
            }).catch(finish);
            return;
          }
          finish(new Error("Sign-in was cancelled or failed."));
        } catch (e) { finish(e); }
      });
      if (handle && typeof handle.then === "function") {
        listenerPending = handle;
        handle.then(function (h) { listener = h || null; listenerPending = null; },
                    function () { listenerPending = null; });
      } else {
        listener = handle || null;
      }

      p.Browser.open({ url: url, windowName: "_blank", presentationStyle: "popover" })
        .catch(function (e) { finish(e); });

      /* Safety net: don't hang forever if the browser is dismissed. */
      setTimeout(function () {
        if (!done) finish(new Error("Sign-in timed out — please try again."));
      }, 120000);
    });
  } catch (e) {
    throw friendlySignInError(provider, e);
  }
  }

  window.CaddieNativeAuth = {
    signInWithGoogle: function (client) { return signInWithProvider(client, "google"); },
    signInWithApple: function (client) { return signInWithProvider(client, "apple"); },
    callbackScheme: CALLBACK_SCHEME
  };
})();
