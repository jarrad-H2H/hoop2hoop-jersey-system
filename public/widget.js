// FILE: public/widget.js
(function () {
  function findSelectedSizeValue() {
    try {
      var variantSelects = document.querySelector("variant-selects");
      if (variantSelects) {
        var selects = variantSelects.querySelectorAll("select");
        if (selects && selects.length) {
          for (var i = 0; i < selects.length; i++) {
            var sel = selects[i];
            var name = (sel.getAttribute("name") || "").toLowerCase();
            if (name.indexOf("size") !== -1) return (sel.value || "").trim();
          }
          return (selects[0].value || "").trim();
        }
      }

      var variantRadios = document.querySelector("variant-radios");
      if (variantRadios) {
        var fieldsets = variantRadios.querySelectorAll("fieldset");
        for (var f = 0; f < fieldsets.length; f++) {
          var fs = fieldsets[f];
          var legend = fs.querySelector("legend");
          var legendText = (legend && legend.textContent ? legend.textContent : "").toLowerCase();
          if (legendText.indexOf("size") !== -1) {
            var checked = fs.querySelector('input[type="radio"]:checked');
            if (checked) return (checked.value || "").trim();
          }
        }
        var anyChecked = variantRadios.querySelector('input[type="radio"]:checked');
        if (anyChecked) return (anyChecked.value || "").trim();
      }

      return "";
    } catch (_) {
      return "";
    }
  }

  function findSelectedVariantId() {
    try {
      var input = document.querySelector('form[action^="/cart/add"] input[name="id"]');
      return input ? (input.value || "").trim() : "";
    } catch (_) {
      return "";
    }
  }

  function mount() {
    var host =
      document.querySelector('[data-h2h-widget]') ||
      document.getElementById("h2h-jersey-widget");

    if (!host) return;
    if (host.getAttribute("data-h2h-mounted") === "true") return;
    host.setAttribute("data-h2h-mounted", "true");

    var baseUrl = new URL(document.currentScript.src).origin;

    // ✅ Product ID comes from the placeholder (rendered in main-product.liquid)
    var productId = "";
    try {
      productId = (host.getAttribute("data-product-id") || "").trim();
    } catch (_) {}

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
      try {
        var size = findSelectedSizeValue();
        var variantId = findSelectedVariantId();

        iframe.contentWindow &&
          iframe.contentWindow.postMessage(
            {
              type: "h2h:variantChanged",
              size: size,
              variantId: variantId,
            },
            "*"
          );
      } catch (_) {}
    }

    iframe.addEventListener("load", function () {
      sendVariantState();
    });

    document.addEventListener("change", function (e) {
      var t = e && e.target;
      if (!t) return;

      var inVariantArea =
        t.closest("variant-radios") ||
        t.closest("variant-selects") ||
        t.closest(".product-form") ||
        t.closest("product-info");

      if (inVariantArea) sendVariantState();
    });

    // Widget -> Shopify page messages
    window.addEventListener("message", function (event) {
      try {
        if (!event || !event.data) return;
        var data = event.data;

        if (data.type === "h2h:reservation:ready") {
          window.dispatchEvent(new CustomEvent("h2h:reservation:ready"));

          var input = document.getElementById("h2h_jersey_number");
          if (input) input.value = String(data.jerseyNumber);

          if (input) {
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }

        if (data.type === "h2h:reservation:cleared") {
          window.dispatchEvent(new CustomEvent("h2h:reservation:cleared"));

          var input2 = document.getElementById("h2h_jersey_number");
          if (input2) input2.value = "";
          if (input2) {
            input2.dispatchEvent(new Event("input", { bubbles: true }));
            input2.dispatchEvent(new Event("change", { bubbles: true }));
          }
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
