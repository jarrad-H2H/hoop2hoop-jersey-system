// FILE: public/widget.js
(function () {
  var lastSentKey = "";

  function $(sel, root) {
    try { return (root || document).querySelector(sel); } catch (_) { return null; }
  }
  function $all(sel, root) {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); } catch (_) { return []; }
  }

  function findHost() {
    return ($('[data-h2h-widget]') || document.getElementById("h2h-jersey-widget"));
  }

  function findProductScope(host) {
    return host.closest('section[id^="MainProduct-"]') || host.closest("main") || document;
  }

  function findSelectedVariantId(scope) {
    var input = $('.product-variant-id:not([disabled])', scope) || $('.product-variant-id', scope);
    if (input && input.value) return String(input.value).trim();
    var fallback = $('form[action^="/cart/add"] input[name="id"]', scope);
    return fallback && fallback.value ? String(fallback.value).trim() : "";
  }

  function findSelectedSizeValue(scope) {
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

    var globoActive =
      $('.swatch-anchor[aria-pressed="true"]', scope) ||
      $('.swatch-anchor.active', scope) ||
      $('.swatch-anchor.selected', scope) ||
      $('.swatch-anchor.is-selected', scope) ||
      $('.swatch-anchor.globo-active', scope);

    if (globoActive && globoActive.textContent) return globoActive.textContent.trim();

    var checkedSwatch = $('input[id^="swatch-detail-"]:checked', scope);
    if (checkedSwatch) {
      var lbl = $('label[for="' + checkedSwatch.id + '"]', scope);
      if (lbl && lbl.textContent) return lbl.textContent.trim();
      if (checkedSwatch.value) return String(checkedSwatch.value).trim();
    }

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

  function mount() {
    var host = findHost();
    if (!host) return;

    if (host.getAttribute("data-h2h-mounted") === "true") return;
    host.setAttribute("data-h2h-mounted", "true");

    var scope = findProductScope(host);
    var baseUrl = new URL(document.currentScript.src).origin;

    var productId = "";
    try { productId = (host.getAttribute("data-product-id") || "").trim(); } catch (_) {}

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

    // Widget -> Shopify messages
    window.addEventListener("message", function (event) {
      try {
        if (!event || !event.data) return;
        var data = event.data;

        if (data.type === "h2h:reservation:ready") {
          // forward as a DOM event with detail so theme code can fill hidden inputs
          window.dispatchEvent(new CustomEvent("h2h:reservation:ready", {
            detail: {
              jerseyNumber: data.jerseyNumber,
              pendingAllocationId: data.pendingAllocationId || ""
            }
          }));
        }

        if (data.type === "h2h:reservation:cleared") {
          window.dispatchEvent(new CustomEvent("h2h:reservation:cleared", { detail: {} }));
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
