/*
 * iframe-content-loader.js
 * ------------------------
 * Used by every "*-content.html" page (the pages that load inside the
 * dashboard/login iframe). Each such page still loads the full app.js
 * (so all existing logic/data/API calls keep working exactly as before),
 * but instead of showing the Dashboard by default, it auto-navigates to
 * whichever section this specific file represents, using the SAME public
 * entry points app.js already exposes:
 *
 *   window.lexoraNavigate(parentId, subId)   -> for top-menu sections
 *   window.handleUserAction(action)          -> for profile-menu sections
 *
 * Which one to call is read from data-nav-* attributes on <body>, e.g.:
 *   <body data-nav-parent="payment">
 *   <body data-nav-action="Profile">
 *
 * This file also tells the parent shell (login.html / dashboard.html)
 * once the user is confirmed logged in or logged out, via postMessage,
 * so the shell can redirect if needed (e.g. session expired).
 */
(function () {
    "use strict";

    function notifyParent(status) {
        try {
            if (window.parent && window.parent !== window) {
                window.parent.postMessage({ lexoraFrame: true, status: status }, "*");
            }
        } catch (e) { /* cross-origin or no parent - ignore */ }
    }

    var tries = 0;
    var maxTries = 200; // ~30s safety cap

    var poll = setInterval(function () {
        tries++;
        var shell = document.getElementById("appShell");

        if (shell && shell.style.display !== "none") {
            clearInterval(poll);
            notifyParent("logged-in");

            var body = document.body;
            var action = body.getAttribute("data-nav-action");
            var parent = body.getAttribute("data-nav-parent");
            var sub = body.getAttribute("data-nav-sub");

            try {
                if (action && window.handleUserAction) {
                    window.handleUserAction(action);
                } else if (parent && window.lexoraNavigate) {
                    window.lexoraNavigate(parent, sub || null);
                }
            } catch (e) {
                console.error("Lexora iframe navigation error:", e);
            }
            return;
        }

        // NOTE: we deliberately do NOT auto-notify the parent shell of a
        // "logged-out" state here anymore. Detecting that reliably would
        // need to distinguish "boot() just hasn't finished its API calls
        // yet" from "the session is genuinely invalid" - on a slower
        // network the former can easily take longer than any fixed
        // timeout, which caused false positives and a login<->dashboard
        // reload loop on every single navigation. If a session truly
        // expires, this page will simply show its own embedded login
        // form (app.js's normal authScreen) inside the content area,
        // which is safe and always correct, just not a full-shell
        // redirect.

        if (tries >= maxTries) clearInterval(poll);
    }, 150);

    // Also catch logout happening WHILE this content page is open
    // (e.g. session expired mid-use) so the shell can react.
    window.addEventListener("storage", function (e) {
        if (e.key === "lexora_session_user_id" && !e.newValue) {
            notifyParent("logged-out");
        }
    });
})();
