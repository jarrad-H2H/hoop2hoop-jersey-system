// FILE: public/widget.js
(function () {
  function findSelectedSizeValue() {
    // Dawn variants are usually managed via <variant-selects> or <variant-radios>
    // We'll grab the selected option that corresponds to the Size option if possible,
    // otherwise fall back to the currently selected variant title part.
    try {
      // 1) variant-selects dropdowns (some stores)
      var variantSelects = document.querySelector("variant-selects");
      if (variantSelects) {
        var selects = variantSelects.querySelectorAll("select");
        if (selects && selects.length) {
          // Best effort: if any select has name "options[Size]" or label nearby includes Size
          for (var i = 0; i < selects.length; i++) {
            var sel = selects[i];
            var name = (sel.getAttribute("name") || "").toLowerCase();
            if (name.indexOf("size") !== -1) {
              return (sel.value || "").trim();
            }
          }
          // fallback: first select
          return (selects[0].value || "").trim();
        }
      }

      // 2) variant-radios buttons (Dawn size pills)
      var variantRadios = document.querySelector("variant-radios");
      if (variantRadios) {
        // Try to find a fieldset that looks like size
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
        // fallback: any checked radio
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

    // pull club name/handle from the placeholder dataset (you already render this)
    var club = "";
    try {
      club = (host.getAttribute("data-club-handle") || "").trim();
    } catch (_) {}

    // Embed the widget
    var iframe = document.createElement("iframe");
    iframe.src =
      baseUrl +
      "/embed/widget-demo" +
      "?club=" +
      encodeURIComponent(club || "");
    iframe.style.width = "100%";
    iframe.style.border = "0";
    iframe.style.minHeight = "520px";
    iframe.setAttribute("loading", "lazy");

    host.appendChild(iframe);

    // Send size + variantId to the widget (on load and whenever it changes)
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

    // Watch for changes anywhere in the product form area
    document.addEventListener("change", function (e) {
      // Only react if the change happened within product form / variants area
      var t = e && e.target;
      if (!t) return;

      // variant selectors typically live in these containers
      var inVariantArea =
        t.closest("variant-radios") ||
        t.closest("variant-selects") ||
        t.closest(".product-form") ||
        t.closest("product-info");

      if (inVariantArea) {
        sendVariantState();
      }
    });

    // Listen for widget -> Shopify page messages (reservation ready/cleared)
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
