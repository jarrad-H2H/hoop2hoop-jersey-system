// FILE: public/widget.js
(function () {
  var lastSentKey = "";

  // Track original ATC label so we can restore it when reservation clears
  var originalAtcLabel = null;

  function $(sel, root) {
    try {
      return (root || document).querySelector(sel);
    } catch (_) {
      return null;
    }
  }
  function $all(sel, root) {
    try {
      return Array.prototype.slice.call((root || document).querySelectorAll(sel));
    } catch (_) {
      return [];
    }
  }

  function findHost() {
    return $('[data-h2h-widget]') || document.getElementById("h2h-jersey-widget");
  }

  function findProductScope(host) {
    return host.closest('section[id^="MainProduct-"]') || host.closest("main") || document;
  }

  function findSelectedVariantId(scope) {
    var input = $(".product-variant-id:not([disabled])", scope) || $(".product-variant-id", scope);
    if (input && input.value) return String(input.value).trim();

    var fallback = $('form[action^="/cart/add"] input[name="id"]', scope);
    return fallback && fallback.value ? String(fallback.value).trim() : "";
  }

  function findSelectedSizeValue(scope) {
    // 1) Dawn variant-selects dropdowns
    var variantSelects = $("variant-selects", scope);
    if (variantSelects) {
      var selects = $all("select", variantSelects);
      for (var i = 0; i < selects.length; i++) {
        var sel = selects[i];
        var name = (sel.getAttribute("name") || "").toLowerCase();
        if (name.indexOf("size") !== -1) return (sel.value || "").trim();
      }
      if (selects[0] && selects[0].value) return (selects[0].value || "").trim();
    }

    // 2) Dawn variant-radios (native size pills)
    var variantRadios = $("variant-radios", scope);
    if (variantRadios) {
      var fieldsets = $all("fieldset", variantRadios);
      for (var f = 0; f < fieldsets.length; f++) {
        var fs = fieldsets[f];
        var legend = $("legend", fs);
        var legendText = (legend && legend.textContent ? legend.textContent : "").toLowerCase();
        if (legendText.indexOf("size") !== -1) {
          var checked = $('input[type="radio"]:checked', fs);
          if (checked && checked.value) return (checked.value || "").trim();
        }
      }
      var anyChecked = $('input[type="radio"]:checked', variantRadios);
      if (anyChecked && anyChecked.value) return (anyChecked.value || "").trim();
    }

    // 3) Globo swatches (label.swatch-anchor ...)
    var globoActive =
      $('.swatch-anchor[aria-pressed="true"]', scope) ||
      $('.swatch-anchor.active', scope) ||
      $('.swatch-anchor.selected', scope) ||
      $('.swatch-anchor.is-selected', scope) ||
      $('.swatch-anchor.globo-active', scope);

    if (globoActive && globoActive.textContent) {
      return globoActive.textContent.trim();
    }

    // 3b) Globo input checked
    var checkedSwatch = $('input[id^="swatch-detail-"]:checked', scope);
    if (checkedSwatch) {
      var lbl = $('label[for="' + checkedSwatch.id + '"]', scope);
      if (lbl && lbl.textContent) return lbl.textContent.trim();
      if (checkedSwatch.value) return String(checkedSwatch.value).trim();
    }

    // 4) Conservative fallback: "Size: YL"
    var info = $(".product__info-container", scope) || scope;
    var text = info && info.innerText ? info.innerText : "";
    var m = text.match(/Size:\s*([A-Za-z0-9]+)/);
    if (m && m[1]) return String(m[1]).trim();

    return "";
  }

  function scheduleSend(iframe, payload, force) {
    var key = (payload.productId || "") + "|" + (payload.variantId || "") + "|" + (payload.size || "");
    if (!force && key === lastSentKey) return;
    lastSentKey = key;

    try {
      iframe.contentWindow && iframe.contentWindow.postMessage(payload, "*");
    } catch (_) {}
  }

  // ---------- ATC BUTTON FIX ----------
  function findAtcButton(scope) {
    return (
      $('button[data-h2h-atc="true"]', scope) ||
      $('button[name="add"][type="submit"]', scope) ||
      $('form[action^="/cart/add"] button[type="submit"]', scope)
    );
  }

  function getAtcLabelNode(btn) {
    if (!btn) return null;
    var span = $("span", btn);
    return span || btn;
  }

  function snapshotOriginalAtcLabel(scope) {
    var btn = findAtcButton(scope);
    if (!btn) return;
    var node = getAtcLabelNode(btn);
    if (!node) return;

    var txt = (node.textContent || "").trim();
    if (txt && originalAtcLabel === null) {
      originalAtcLabel = txt;
    }
  }

  function forceAtcLabel(scope, label) {
    var btn = findAtcButton(scope);
    if (!btn) return;

    var node = getAtcLabelNode(btn);
    if (!node) return;

    if (originalAtcLabel === null) {
      var current = (node.textContent || "").trim();
      if (current) originalAtcLabel = current;
    }

    node.textContent = label;
    try {
      btn.setAttribute("aria-label", label);
    } catch (_) {}
  }

  function restoreAtcLabel(scope) {
    if (!originalAtcLabel) return;
    forceAtcLabel(scope, originalAtcLabel);
  }
  // -----------------------------------

  function setHiddenInputValue(id, value) {
    var input = document.getElementById(id);
    if (!input) return;
    input.value = value;

    try {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (_) {}
  }

  function mount() {
    var host = findHost();
    if (!host) return;

    if (host.getAttribute("data-h2h-mounted") === "true") return;
    host.setAttribute("data-h2h-mounted", "true");

    var scope = findProductScope(host);
    var baseUrl = new URL(document.currentScript.src).origin;

    var productId = "";
    try {
      productId = (host.getAttribute("data-product-id") || "").trim();
    } catch (_) {}

    snapshotOriginalAtcLabel(scope);

    var iframe = document.createElement("iframe");
    iframe.src = baseUrl + "/embed/widget-demo" + "?productId=" + encodeURIComponent(productId || "");
    iframe.style.width = "100%";
    iframe.style.border = "0";
    iframe.style.minHeight = "520px";
    iframe.setAttribute("loading", "lazy");

    host.appendChild(iframe);

    function sendVariantState(force) {
      var size = findSelectedSizeValue(scope);
      var variantId = findSelectedVariantId(scope);

      scheduleSend(
        iframe,
        {
          type: "h2h:variantChanged",
          productId: productId,
          size: size,
          variantId: variantId,
        },
        force
      );

      snapshotOriginalAtcLabel(scope);
    }

    iframe.addEventListener("load", function () {
      sendVariantState();
    });

    scope.addEventListener("click", function (e) {
      var t = e && e.target;
      if (!t) return;

      if (
        (t.classList && t.classList.contains("swatch-anchor")) ||
        (t.closest && t.closest(".swatch-anchor")) ||
        (t.tagName === "LABEL" && (t.getAttribute("for") || "").indexOf("swatch-detail-") === 0)
      ) {
        setTimeout(sendVariantState, 0);
      }
    });

    try {
      var mo = new MutationObserver(function () {
        setTimeout(sendVariantState, 0);
      });
      mo.observe(scope, { subtree: true, attributes: true, childList: true });
    } catch (_) {}

    scope.addEventListener("change", function () {
      setTimeout(sendVariantState, 0);
    });

    // Widget -> Shopify messages
    window.addEventListener("message", function (event) {
      try {
        if (!event || !event.data) return;
        var data = event.data;

        if (data.type === "h2h:reservation:ready") {
          var jerseyNum = data.jerseyNumber;
          var pendingId = data.pendingAllocationId || "";

          // Dispatch CustomEvent with detail so buy-buttons.liquid unlocks
          window.dispatchEvent(
            new CustomEvent("h2h:reservation:ready", {
              detail: { jerseyNumber: jerseyNum, pendingAllocationId: pendingId },
            })
          );

          // Set hidden line item properties. h2h_reserved_at lets the cart watchdog
          // (see runCartWatchdog below) know when this hold's 30-minute window started,
          // so it can clear the line item if it's still sitting unpurchased well after
          // the reservation itself has lapsed.
          setHiddenInputValue("h2h_jersey_number", String(jerseyNum));
          setHiddenInputValue("h2h_pending_allocation_id", String(pendingId));
          setHiddenInputValue("h2h_reserved_at", new Date().toISOString());

          // Force label once unlocked
          forceAtcLabel(scope, "Add to cart");
        }

        if (data.type === "h2h:reservation:cleared") {
          window.dispatchEvent(new CustomEvent("h2h:reservation:cleared"));

          // Clear hidden line item properties
          setHiddenInputValue("h2h_jersey_number", "");
          setHiddenInputValue("h2h_pending_allocation_id", "");
          setHiddenInputValue("h2h_reserved_at", "");

          restoreAtcLabel(scope);
        }

        // The widget asks for the current size/variant the moment it's actually ready
        // to receive it -- closes the race where a customer taps a size before the
        // iframe's React app has attached its own listener, which would otherwise
        // drop that selection silently with no retry. "force" bypasses the dedupe
        // below so the same size/variant gets resent even if nothing has changed.
        if (data.type === "h2h:requestState") {
          sendVariantState(true);
        }

        // Widget reports its real content height as questions/results appear, so the
        // iframe can grow to fit instead of showing its own internal scrollbar --
        // customers were missing newly-revealed content further down the form.
        if (data.type === "h2h:resize" && typeof data.height === "number" && data.height > 0) {
          iframe.style.height = data.height + "px";
        }
      } catch (_) {}
    });
  }

  // ---------- CART WATCHDOG ----------
  // Catches the case where a customer reserves a number, adds it to their cart, then
  // comes back well after the 30-minute hold has lapsed and checks out anyway. Shopify
  // has no idea our reservation expired -- it'll happily let them pay. This runs on
  // EVERY page (not just the product page, since this script needs to load site-wide
  // via theme.liquid for the check to matter) and clears any stale H2H line item from
  // the cart before that can happen, same as the customer clicking "Remove" themselves.
  var H2H_RESERVATION_MINUTES = 30;

  function showExpiredCartBanner(count) {
    try {
      if (document.getElementById("h2h-expired-banner")) return;

      var banner = document.createElement("div");
      banner.id = "h2h-expired-banner";
      banner.setAttribute("role", "alert");
      banner.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:999999;" +
        "background:#fff7ed;color:#9a3412;border-bottom:2px solid #f59e0b;" +
        "padding:10px 16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;" +
        "text-align:center;";

      var msg = document.createElement("span");
      msg.textContent =
        count === 1
          ? "Your jersey number reservation expired, so we've removed it from your cart. Please go back to the product and choose your number again."
          : "Some jersey number reservations in your cart expired, so we've removed them. Please go back to the product(s) and choose your number(s) again.";
      banner.appendChild(msg);

      var closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.textContent = "Dismiss";
      closeBtn.style.cssText =
        "margin-left:10px;background:none;border:1px solid #9a3412;color:#9a3412;" +
        "padding:2px 10px;border-radius:4px;cursor:pointer;font-size:12px;";
      closeBtn.onclick = function () {
        banner.parentNode && banner.parentNode.removeChild(banner);
      };
      banner.appendChild(closeBtn);

      document.body.insertBefore(banner, document.body.firstChild);
    } catch (_) {}
  }

  function runCartWatchdog() {
    if (window.__h2hCartWatchdogStarted) return;
    window.__h2hCartWatchdogStarted = true;

    var expiryMs = H2H_RESERVATION_MINUTES * 60 * 1000;

    fetch("/cart.js", { credentials: "same-origin" })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (cart) {
        if (!cart || !Array.isArray(cart.items)) return;

        var stale = cart.items.filter(function (item) {
          var props = item.properties || {};
          var reservedAtRaw = props.h2h_reserved_at || props._h2h_reserved_at;
          var pendingId = props.h2h_pending_allocation_id;
          if (!reservedAtRaw || !pendingId) return false;
          var reservedAt = Date.parse(reservedAtRaw);
          if (!isFinite(reservedAt)) return false;
          return Date.now() - reservedAt > expiryMs;
        });

        if (stale.length === 0) return;

        var removals = stale.map(function (item) {
          return fetch("/cart/change.js", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: item.key, quantity: 0 }),
          }).catch(function () {});
        });

        Promise.all(removals).then(function () {
          showExpiredCartBanner(stale.length);
        });
      })
      .catch(function () {});
  }
  // -----------------------------------

  function init() {
    mount();
    runCartWatchdog();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
