// FILE: public/widget.js
(function () {
  var lastSentKey = "";
  var sendTimer = null;

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

  function debouncedSend(iframe, payload) {
    if (sendTimer) clearTimeout(sendTimer);
    sendTimer = setTimeout(function () {
      try {
        var key =
          (payload.productId || "") + "|" + (payload.variantId || "") + "|" + (payload.size || "");
        if (key === lastSentKey) return;
        lastSentKey = key;

        iframe.contentWindow && iframe.contentWindow.postMessage(payload, "*");
      } catch (_) {}
    }, 60);
  }

  function findAddToCartButton(scope) {
    // Dawn typically uses <button name="add"> inside the product form
    return (
      $('form[action^="/cart/add"] button[name="add"]', scope) ||
      $('form[action^="/cart/add"] button[type="submit"]', scope)
    );
  }

  function setButtonLabel(btn, label) {
    if (!btn) return;
    // Store original label once
    if (!btn.getAttribute("data-h2h-original-label")) {
      btn.setAttribute("data-h2h-original-label", (btn.textContent || "").trim());
    }

    // Dawn often has nested spans
    var span = btn.querySelector("span");
    if (span) {
      span.textContent = label;
    } else {
      btn.textContent = label;
    }
  }

  function restoreButtonLabel(btn) {
    if (!btn) return;
    var original = btn.getAttribute("data-h2h-original-label");
    if (original) setButtonLabel(btn, original);
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

      debouncedSend(iframe, {
        type: "h2h:variantChanged",
        productId: productId,
        size: size,
        variantId: variantId,
      });
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

    scope.addEventListener("change", function () {
      setTimeout(sendVariantState, 0);
    });

    try {
      var mo = new MutationObserver(function () {
        sendVariantState();
      });
      mo.observe(scope, { subtree: true, attributes: true, childList: true });
    } catch (_) {}

    // Widget -> Shopify messages
    window.addEventListener("message", function (event) {
      try {
        if (!event || !event.data) return;
        var data = event.data;

        if (data.type === "h2h:reservation:ready") {
          var jerseyNum = data.jerseyNumber;

          // set hidden line item property
          var input = document.getElementById("h2h_jersey_number");
          if (input) input.value = String(jerseyNum);
          if (input) {
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }

          // unlock + pass detail
          window.dispatchEvent(
            new CustomEvent("h2h:reservation:ready", {
              detail: { jerseyNumber: jerseyNum },
            })
          );

          // ✅ force button label to Add to cart (even if theme thinks sold out)
          var atc = findAddToCartButton(scope);
          setButtonLabel(atc, "Add to cart");
        }

        if (data.type === "h2h:reservation:cleared") {
          var input2 = document.getElementById("h2h_jersey_number");
          if (input2) input2.value = "";
          if (input2) {
            input2.dispatchEvent(new Event("input", { bubbles: true }));
            input2.dispatchEvent(new Event("change", { bubbles: true }));
          }

          window.dispatchEvent(new CustomEvent("h2h:reservation:cleared", { detail: {} }));

          // restore whatever the theme originally had
          var atc2 = findAddToCartButton(scope);
          restoreButtonLabel(atc2);
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
