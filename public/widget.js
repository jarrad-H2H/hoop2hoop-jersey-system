// FILE: public/widget.js
(function () {
  var lastSentKey = "";
  var lastReservation = { jerseyNumber: null, pendingAllocationId: null };

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
    // Dawn buy-buttons keeps this updated
    var input = $(".product-variant-id:not([disabled])", scope) || $(".product-variant-id", scope);
    if (input && input.value) return String(input.value).trim();

    // Fallback
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

    // 2) Dawn variant-radios (native pills)
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

    // 3) Globo swatches (your store uses label.swatch-anchor)
    // Prefer "active/selected" patterns first
    var globoActive =
      $('.swatch-anchor[aria-pressed="true"]', scope) ||
      $(".swatch-anchor.active", scope) ||
      $(".swatch-anchor.selected", scope) ||
      $(".swatch-anchor.is-selected", scope) ||
      $(".swatch-anchor.globo-active", scope);

    if (globoActive && globoActive.textContent) {
      return globoActive.textContent.trim();
    }

    // 3b) Globo checked input
    var checkedSwatch = $('input[id^="swatch-detail-"]:checked', scope);
    if (checkedSwatch) {
      var lbl = $('label[for="' + checkedSwatch.id + '"]', scope);
      if (lbl && lbl.textContent) return lbl.textContent.trim();
      if (checkedSwatch.value) return String(checkedSwatch.value).trim();
    }

    // 4) Conservative fallback from product info text
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
      if (iframe.contentWindow) iframe.contentWindow.postMessage(payload, "*");
    } catch (_) {}
  }

  function setHiddenJerseyValue(num) {
    try {
      var input = document.getElementById("h2h_jersey_number");
      if (!input) return;
      input.value = String(num);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (_) {}
  }

  function clearHiddenJerseyValue() {
    try {
      var input = document.getElementById("h2h_jersey_number");
      if (!input) return;
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (_) {}
  }

  function dispatchReady(num, pendingAllocationId) {
    try {
      lastReservation.jerseyNumber = num;
      lastReservation.pendingAllocationId = pendingAllocationId || null;

      window.dispatchEvent(
        new CustomEvent("h2h:reservation:ready", {
          detail: { jerseyNumber: num, pendingAllocationId: pendingAllocationId || null },
        })
      );
    } catch (_) {}
  }

  function dispatchCleared() {
    try {
      lastReservation.jerseyNumber = null;
      lastReservation.pendingAllocationId = null;

      window.dispatchEvent(new CustomEvent("h2h:reservation:cleared"));
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

    // Embed widget
    var iframe = document.createElement("iframe");
    iframe.src = baseUrl + "/embed/widget-demo" + "?productId=" + encodeURIComponent(productId || "");
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
    }

    // Initial send
    iframe.addEventListener("load", function () {
      sendVariantState();
    });

    // Click handler catches Globo pills
    scope.addEventListener("click", function (e) {
      var t = e && e.target;
      if (!t) return;

      var isGlobo =
        (t.classList && t.classList.contains("swatch-anchor")) ||
        (t.closest && t.closest(".swatch-anchor")) ||
        (t.tagName === "LABEL" && (t.getAttribute("for") || "").indexOf("swatch-detail-") === 0);

      if (isGlobo) setTimeout(sendVariantState, 0);
    });

    // Native changes (Dawn)
    scope.addEventListener("change", function (e) {
      var t = e && e.target;
      if (!t) return;

      // Only respond inside product area controls
      var inVariantArea =
        t.closest("variant-radios") ||
        t.closest("variant-selects") ||
        t.closest(".product-form") ||
        t.closest("product-info") ||
        t.closest(".product__info-container");

      if (inVariantArea) setTimeout(sendVariantState, 0);
    });

    // Very lightweight mutation observer (attributes only, debounced)
    // Avoid watching childList to prevent heavy loops on Shopify apps.
    try {
      var debounce = null;
      var mo = new MutationObserver(function () {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(sendVariantState, 50);
      });
      mo.observe(scope, { subtree: true, attributes: true });
    } catch (_) {}

    // Widget -> Shopify messages
    window.addEventListener("message", function (event) {
      try {
        if (!event || !event.data) return;
        var data = event.data;

        if (data.type === "h2h:reservation:ready") {
          var num = data.jerseyNumber;
          var pendingId = data.pendingAllocationId || null;

          // allow 0
          if (!(num === 0 || (typeof num === "number" && isFinite(num)))) return;

          setHiddenJerseyValue(num);
          dispatchReady(num, pendingId);
        }

        if (data.type === "h2h:reservation:cleared") {
          clearHiddenJerseyValue();
          dispatchCleared();
        }
      } catch (_) {}
    });

    // On variant change, if the customer changes size/variant AFTER reserving,
    // we clear the hidden input and re-lock (widget should force re-check anyway).
    scope.addEventListener("change", function () {
      // Don’t clear if no reservation
      if (lastReservation.jerseyNumber === null) return;
      // Clear immediately so button re-locks and customer must re-reserve
      clearHiddenJerseyValue();
      dispatchCleared();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
