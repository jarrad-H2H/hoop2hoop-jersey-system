// FILE: public/widget.js
// Self-injecting widget — no Shopify theme file edits required.
// Loaded via Shopify ScriptTag API (registered once, survives all theme updates).
// On product pages: auto-detects the product ID, checks for an H2H club mapping,
// injects the widget container + all hidden form inputs, and mounts the iframe.
// On non-product pages or unmapped products: exits silently with no visible effect.
(function () {
  // Capture base URL synchronously. document.currentScript works when Shopify
  // renders the <script> tag server-side; fall back to a DOM search in case
  // Shopify injects the tag dynamically (currentScript is null in that path).
  var baseUrl = "https://hoop2hoop-jersey-system.vercel.app";
  try {
    if (document.currentScript && document.currentScript.src) {
      baseUrl = new URL(document.currentScript.src).origin;
    } else {
      var scripts = document.querySelectorAll('script[src*="widget.js"]');
      for (var _si = scripts.length - 1; _si >= 0; _si--) {
        var _u = new URL(scripts[_si].src);
        if (_u.pathname.indexOf("widget.js") !== -1) { baseUrl = _u.origin; break; }
      }
    }
  } catch (_) {}

  var lastSentKey = "";
  var originalAtcLabel = null;

  // ── Utilities ────────────────────────────────────────────────────────────────
  function $(sel, root) {
    try { return (root || document).querySelector(sel); } catch (_) { return null; }
  }
  function $all(sel, root) {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
    catch (_) { return []; }
  }

  // ── Product page detection ───────────────────────────────────────────────────
  function isProductPage() {
    return window.location.pathname.indexOf("/products/") !== -1;
  }

  // Try multiple Shopify-standard locations for the product ID.
  // Shopify guarantees ShopifyAnalytics.meta.product.id on all product pages;
  // the fallbacks cover edge cases (headless, older themes, page caching).
  function getShopifyProductId() {
    try {
      var id = window.ShopifyAnalytics &&
               window.ShopifyAnalytics.meta &&
               window.ShopifyAnalytics.meta.product &&
               window.ShopifyAnalytics.meta.product.id;
      if (id) return String(id);
    } catch (_) {}

    try {
      // Dawn product form carries data-product-id on the form element itself
      var form = $('form[action^="/cart/add"]');
      if (form) {
        var attr = form.getAttribute("data-product-id") ||
                   form.getAttribute("data-productid");
        if (attr) return attr.trim();
      }
    } catch (_) {}

    try {
      // Shopify __st analytics script (Dawn 9+)
      var stEl = document.getElementById("__st");
      if (stEl) {
        var stData = JSON.parse(stEl.textContent || "{}");
        if (stData.pid) return String(stData.pid);
      }
    } catch (_) {}

    return "";
  }

  // ── Variant / size reading ───────────────────────────────────────────────────
  function findProductScope(host) {
    return host.closest('section[id^="MainProduct-"]') ||
           host.closest("main") ||
           document;
  }

  function findSelectedVariantId(scope) {
    var input = $(".product-variant-id:not([disabled])", scope) ||
                $(".product-variant-id", scope);
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

    // 3) Globo swatches
    var globoActive =
      $('.swatch-anchor[aria-pressed="true"]', scope) ||
      $(".swatch-anchor.active", scope) ||
      $(".swatch-anchor.selected", scope) ||
      $(".swatch-anchor.is-selected", scope) ||
      $(".swatch-anchor.globo-active", scope);
    if (globoActive && globoActive.textContent) return globoActive.textContent.trim();

    var checkedSwatch = $('input[id^="swatch-detail-"]:checked', scope);
    if (checkedSwatch) {
      var lbl = $('label[for="' + checkedSwatch.id + '"]', scope);
      if (lbl && lbl.textContent) return lbl.textContent.trim();
      if (checkedSwatch.value) return String(checkedSwatch.value).trim();
    }

    // 4) Conservative fallback
    var info = $(".product__info-container", scope) || scope;
    var text = info && info.innerText ? info.innerText : "";
    var m = text.match(/Size:\s*([A-Za-z0-9]+)/);
    if (m && m[1]) return String(m[1]).trim();

    return "";
  }

  // ── Variant change messaging ─────────────────────────────────────────────────
  function scheduleSend(iframe, payload, force) {
    var key = (payload.productId || "") + "|" + (payload.variantId || "") + "|" + (payload.size || "");
    if (!force && key === lastSentKey) return;
    lastSentKey = key;
    try { iframe.contentWindow && iframe.contentWindow.postMessage(payload, "*"); } catch (_) {}
  }

  // ── ATC button helpers ───────────────────────────────────────────────────────
  function findAtcButton(scope) {
    return (
      $('button[data-h2h-atc="true"]', scope) ||
      $('button[name="add"][type="submit"]', scope) ||
      $('form[action^="/cart/add"] button[type="submit"]', scope)
    );
  }

  function getAtcLabelNode(btn) {
    if (!btn) return null;
    return $("span", btn) || btn;
  }

  function snapshotOriginalAtcLabel(scope) {
    var btn = findAtcButton(scope);
    if (!btn) return;
    var node = getAtcLabelNode(btn);
    if (!node) return;
    var txt = (node.textContent || "").trim();
    if (txt && originalAtcLabel === null) originalAtcLabel = txt;
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
    try { btn.setAttribute("aria-label", label); } catch (_) {}
  }

  function restoreAtcLabel(scope) {
    if (!originalAtcLabel) return;
    forceAtcLabel(scope, originalAtcLabel);
  }

  // ── Hidden input helpers ─────────────────────────────────────────────────────
  function setHiddenInputValue(id, value) {
    var input = document.getElementById(id);
    if (!input) return;
    input.value = value;
    try {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (_) {}
  }

  // Inject all H2H hidden inputs into the cart form (idempotent — skips if already present).
  // The `name` attributes use Shopify's `properties[_key]` convention; underscore prefix
  // hides them from customer-facing order confirmations.
  var HIDDEN_INPUTS = [
    // Standard reservation flow
    { id: "h2h_jersey_number",          name: "properties[Jersey Number]" },
    { id: "h2h_pending_allocation_id",  name: "properties[_h2h_pending_allocation_id]" },
    { id: "h2h_reserved_at",            name: "properties[_h2h_reserved_at]" },
    // Pre-order flow
    { id: "h2h_preorder_mode",          name: "properties[_h2h_preorder_mode]" },
    { id: "h2h_pref_1",                 name: "properties[_h2h_pref_1]" },
    { id: "h2h_pref_2",                 name: "properties[_h2h_pref_2]" },
    { id: "h2h_pref_3",                 name: "properties[_h2h_pref_3]" },
    { id: "h2h_any_number",             name: "properties[_h2h_any_number]" },
    { id: "h2h_claimed_current",        name: "properties[_h2h_claimed_current]" },
    { id: "h2h_first_name_preorder",    name: "properties[_h2h_first_name_preorder]" },
    { id: "h2h_last_name_preorder",     name: "properties[_h2h_last_name_preorder]" },
    { id: "h2h_yob_preorder",           name: "properties[_h2h_yob_preorder]" },
    { id: "h2h_age_group_preorder",     name: "properties[_h2h_age_group_preorder]" },
    { id: "h2h_club_id_preorder",       name: "properties[_h2h_club_id_preorder]" },
    { id: "h2h_size_preorder",          name: "properties[_h2h_size_preorder]" },
  ];

  function injectHiddenInputs(form) {
    HIDDEN_INPUTS.forEach(function (spec) {
      if (document.getElementById(spec.id)) return; // already present
      var el = document.createElement("input");
      el.type = "hidden";
      el.id = spec.id;
      el.name = spec.name;
      el.value = "";
      form.appendChild(el);
    });
  }

  // ── Main mount ───────────────────────────────────────────────────────────────
  function mount(productId) {
    // Find the cart form — our injection anchor
    var form = $('form[action^="/cart/add"]');
    if (!form) return;

    // Avoid double-mounting (e.g. page cached in BFCache or SPA navigation)
    if (document.getElementById("h2h-widget-host")) return;

    // Create the widget container.
    var host = document.createElement("div");
    host.id = "h2h-widget-host";
    host.setAttribute("data-h2h-widget", "true");
    host.setAttribute("data-product-id", String(productId));
    // No margin until the widget confirms an H2H club mapping and reveals itself.

    // Inject hidden inputs into the form first (must stay inside the form for cart submission).
    injectHiddenInputs(form);

    // Find the best visual insertion point.
    // Dawn structure: variant-radios/variant-selects → [widget goes here] → product-form (ATC btn)
    // We walk up from the form to find variant pickers in the same product-info container,
    // then insert after the last one. Falls back to before the ATC button inside the form.
    var inserted = false;
    var searchRoot =
      form.closest("product-info") ||
      (form.closest("product-form") ? form.closest("product-form").parentElement : null) ||
      form.parentElement;

    if (searchRoot) {
      // Find the last variant picker sibling
      var variantEls = $all("variant-radios, variant-selects", searchRoot);
      var lastVariant = variantEls.length ? variantEls[variantEls.length - 1] : null;
      if (lastVariant && lastVariant.parentNode) {
        var afterVariant = lastVariant.nextSibling;
        if (afterVariant) {
          lastVariant.parentNode.insertBefore(host, afterVariant);
        } else {
          lastVariant.parentNode.appendChild(host);
        }
        inserted = true;
      }
    }

    if (!inserted) {
      // Fallback: before product-form web component
      var productFormEl = form.closest("product-form");
      if (productFormEl && productFormEl.parentNode) {
        productFormEl.parentNode.insertBefore(host, productFormEl);
        inserted = true;
      }
    }

    if (!inserted) {
      // Last resort: inside the form, before the ATC button
      var atcBtn =
        $('button[name="add"][type="submit"]', form) ||
        $('button[type="submit"]', form);
      if (atcBtn) {
        form.insertBefore(host, atcBtn);
      } else {
        form.appendChild(host);
      }
    }

    var scope = findProductScope(host);
    snapshotOriginalAtcLabel(scope);

    // Create the iframe. Start invisible — it becomes visible on the first
    // h2h:resize event with a meaningful height (only fires when a club mapping
    // is found and the widget renders real content). This means non-H2H product
    // pages silently show nothing.
    var iframe = document.createElement("iframe");
    iframe.src = baseUrl + "/embed/widget-demo?productId=" + encodeURIComponent(String(productId));
    iframe.style.width = "100%";
    iframe.style.border = "0";
    iframe.style.height = "0";
    iframe.style.overflow = "hidden";
    iframe.style.opacity = "0";
    iframe.style.transition = "opacity 0.2s";
    iframe.setAttribute("loading", "lazy");
    host.appendChild(iframe);

    // ── Variant state broadcasting ──────────────────────────────────────────
    function sendVariantState(force) {
      var size = findSelectedSizeValue(scope);
      var variantId = findSelectedVariantId(scope);
      scheduleSend(
        iframe,
        { type: "h2h:variantChanged", productId: String(productId), size: size, variantId: variantId },
        force
      );
      snapshotOriginalAtcLabel(scope);
    }

    iframe.addEventListener("load", function () { sendVariantState(); });

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
      var mo = new MutationObserver(function () { setTimeout(sendVariantState, 0); });
      mo.observe(scope, { subtree: true, attributes: true, childList: true });
    } catch (_) {}

    scope.addEventListener("change", function () { setTimeout(sendVariantState, 0); });

    // ── Widget → Shopify messages ───────────────────────────────────────────
    window.addEventListener("message", function (event) {
      try {
        if (!event || !event.data) return;
        var data = event.data;

        if (data.type === "h2h:reservation:ready") {
          var jerseyNum = data.jerseyNumber;
          var pendingId = data.pendingAllocationId || "";

          window.dispatchEvent(new CustomEvent("h2h:reservation:ready", {
            detail: { jerseyNumber: jerseyNum, pendingAllocationId: pendingId },
          }));

          setHiddenInputValue("h2h_jersey_number", String(jerseyNum));
          setHiddenInputValue("h2h_pending_allocation_id", String(pendingId));
          setHiddenInputValue("h2h_reserved_at", new Date().toISOString());

          forceAtcLabel(scope, "Add to cart");
        }

        if (data.type === "h2h:reservation:cleared") {
          window.dispatchEvent(new CustomEvent("h2h:reservation:cleared"));

          setHiddenInputValue("h2h_jersey_number", "");
          setHiddenInputValue("h2h_pending_allocation_id", "");
          setHiddenInputValue("h2h_reserved_at", "");

          restoreAtcLabel(scope);
        }

        // Pre-order: customer submitted preferences
        if (data.type === "h2h:preorder:ready") {
          setHiddenInputValue("h2h_preorder_mode",       "true");
          setHiddenInputValue("h2h_pref_1",              data.pref1 != null ? String(data.pref1) : "");
          setHiddenInputValue("h2h_pref_2",              data.pref2 != null ? String(data.pref2) : "");
          setHiddenInputValue("h2h_pref_3",              data.pref3 != null ? String(data.pref3) : "");
          setHiddenInputValue("h2h_any_number",          data.anyNumber ? "true" : "false");
          setHiddenInputValue("h2h_claimed_current",     data.claimedCurrent != null ? String(data.claimedCurrent) : "");
          setHiddenInputValue("h2h_first_name_preorder", String(data.firstName || ""));
          setHiddenInputValue("h2h_last_name_preorder",  String(data.lastName || ""));
          setHiddenInputValue("h2h_yob_preorder",        data.yob != null ? String(data.yob) : "");
          setHiddenInputValue("h2h_age_group_preorder",  String(data.ageGroup || ""));
          setHiddenInputValue("h2h_club_id_preorder",    String(data.clubId || ""));
          setHiddenInputValue("h2h_size_preorder",       String(data.size || ""));

          window.dispatchEvent(new CustomEvent("h2h:preorder:ready", { detail: data }));
          forceAtcLabel(scope, "Add to cart");
        }

        // Widget asks for current variant the moment its React app is ready to receive it
        if (data.type === "h2h:requestState") {
          sendVariantState(true);
        }

        // Widget reports real content height — used to size the iframe and to reveal it
        // (opacity 0 → 1) on the first resize with meaningful content. Non-H2H product
        // pages never get meaningful content, so their iframe stays invisible.
        if (data.type === "h2h:resize" && typeof data.height === "number") {
          iframe.style.height = data.height + "px";
          if (data.height > 80 && iframe.style.opacity === "0") {
            iframe.style.opacity = "1";
            host.style.marginTop = "1rem";
          }
        }
      } catch (_) {}
    });
  }

  // ── Cart watchdog ─────────────────────────────────────────────────────────
  // Removes stale H2H reservation line items from the cart after the 30-minute
  // hold has lapsed. Pre-order items are intentionally excluded (they have no
  // _h2h_reserved_at property) so they are never auto-removed.
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
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (cart) {
        if (!cart || !Array.isArray(cart.items)) return;
        var stale = cart.items.filter(function (item) {
          var props = item.properties || {};
          var reservedAtRaw = props.h2h_reserved_at || props._h2h_reserved_at;
          if (!reservedAtRaw) return false;
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
        Promise.all(removals).then(function () { showExpiredCartBanner(stale.length); });
      })
      .catch(function () {});
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    runCartWatchdog(); // runs on every page — cart can be stale anywhere

    if (!isProductPage()) return;

    // ShopifyAnalytics isn't available until DOMContentLoaded — by the time
    // we reach here, it should be ready. If not, retry once after a short delay.
    var productId = getShopifyProductId();
    if (productId) {
      mount(productId);
    } else {
      setTimeout(function () {
        productId = getShopifyProductId();
        if (productId) mount(productId);
      }, 500);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
