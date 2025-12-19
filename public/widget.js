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
    var input =
      $(".product-variant-id:not([disabled])", scope) ||
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

  function scheduleSend(iframe, payload) {
    var key = (payload.productId || "") + "|" + (payload.variantId || "") + "|" + (payload.size || "");
    if (key === lastSentKey) return;
    lastSentKey = key;

    try {
      iframe.contentWindow && iframe.contentWindow.postMessage(payload, "*");
    } catch (_) {}
  }

  // ---------- ATC BUTTON FIX (forces label to "Add to cart" when unlocked) ----------
  function findAtcButton(scope) {
    // Prefer our tagged button
    return (
      $('button[data-h2h-atc="true"]', scope) ||
      $('button[name="add"][type="submit"]', scope) ||
      $('form[action^="/cart/add"] button[type="submit"]', scope)
    );
  }

  function getAtcLabelNode(btn) {
    if (!btn) return null;
    // Dawn uses a <span> inside the button for label
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

    // Store original once
    if (originalAtcLabel === null) {
      var current = (node.textContent || "").trim();
      if (current) originalAtcLabel = current;
    }

    node.textContent = label;
    // Also update aria-label if present
    try {
      btn.setAttribute("aria-label", label);
    } catch (_) {}
  }

  function restoreAtcLabel(scope) {
    if (!originalAtcLabel) return;
    forceAtcLabel(scope, originalAtcLabel);
  }

  // -------------------------------------------------------------------------------

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

    // Snapshot the ATC label early (often "Sold out" - we’ll override on unlock)
    snapshotOriginalAtcLabel(scope);

    var iframe = document.createElement("iframe");
    iframe.src =
      baseUrl +
      "/embed/widget-demo" +
      "?productId=" +
      encodeURIComponent(productId || "");
    iframe.style.width = "100%";
    iframe.style.border = "0";
    iframe.style.minHeight = "520px";
    iframe.setAttribute("loading", "lazy");

    host.appendChild(iframe);

    function sendVariantState() {
      var size = findSelectedSizeValue(scope);
      var variantId = findSelectedVariantId(scope);

      scheduleSend(iframe, {
        type: "h2h:variantChanged",
        productId: productId,
        size: size,
        variantId: variantId,
      });

      // Refresh original label snapshot after variant changes too (apps/themes sometimes swap DOM)
      snapshotOriginalAtcLabel(scope);
    }

    iframe.addEventListener("load", function () {
      sendVariantState();
    });

    // Globo pills often don't fire change
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

    // MutationObserver because apps modify selection state via DOM changes
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
          // Keep your existing event bridge
          window.dispatchEvent(new CustomEvent("h2h:reservation:ready"));

          // Set hidden input property
          var input = document.getElementById("h2h_jersey_number");
          if (input) input.value = String(data.jerseyNumber);

          if (input) {
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }

          // ✅ FORCE ATC LABEL to "Add to cart" once reservation is ready
          forceAtcLabel(scope, "Add to cart");
        }

        if (data.type === "h2h:reservation:cleared") {
          window.dispatchEvent(new CustomEvent("h2h:reservation:cleared"));

          var input2 = document.getElementById("h2h_jersey_number");
          if (input2) input2.value = "";
          if (input2) {
            input2.dispatchEvent(new Event("input", { bubbles: true }));
            input2.dispatchEvent(new Event("change", { bubbles: true }));
          }

          // Optional: restore original label (often "Sold out" or localized label)
          restoreAtcLabel(scope);
        }
      } catch (_) {}
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
