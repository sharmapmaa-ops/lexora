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
        var authScreen = document.getElementById("authScreen");

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

        // Not logged in (auth screen visible) and this page requires
        // login - let the shell know so it can show a "please login"
        // state around the iframe if it wants to.
        if (authScreen && authScreen.style.display !== "none" && tries > 4) {
            notifyParent("logged-out");
        }

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
