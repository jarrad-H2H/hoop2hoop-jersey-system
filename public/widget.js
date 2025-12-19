// FILE: public/widget.js
(function () {
  function findSelectedSizeValue() {
    try {
      // 1) variant-selects dropdowns
      var variantSelects = document.querySelector("variant-selects");
      if (variantSelects) {
        var selects = variantSelects.querySelectorAll("select");
        if (selects && selects.length) {
          // Prefer the select whose name looks like Size
          for (var i = 0; i < selects.length; i++) {
            var sel = selects[i];
            var name = (sel.getAttribute("name") || "").toLowerCase();
            if (name.indexOf("size") !== -1) return (sel.value || "").trim();
          }
          return (selects[0].value || "").trim();
        }
      }

      // 2) variant-radios buttons (Dawn size pills)
      var variantRadios = document.querySelector("variant-radios");
      if (variantRadios) {
        // A) Try to find the "Size" fieldset via legend text or input name
        var fieldsets = variantRadios.querySelectorAll("fieldset");
        for (var f = 0; f < fieldsets.length; f++) {
          var fs = fieldsets[f];

          var legend = fs.querySelector("legend");
          var legendText = (legend && legend.textContent ? legend.textContent : "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();

          var anyRadio = fs.querySelector('input[type="radio"]');
          var radioName = (anyRadio && anyRadio.getAttribute("name") ? anyRadio.getAttribute("name") : "")
            .toLowerCase();

          var looksLikeSize = legendText.indexOf("size") !== -1 || radioName.indexOf("size") !== -1;

          if (looksLikeSize) {
            var checked = fs.querySelector('input[type="radio"]:checked');
            if (checked) return (checked.value || "").trim();
          }
        }

        // B) Fallback: checked radio with name containing Size/size
        var checkedByName =
          variantRadios.querySelector('input[type="radio"]:checked[name*="Size"]') ||
          variantRadios.querySelector('input[type="radio"]:checked[name*="size"]');
        if (checkedByName) return (checkedByName.value || "").trim();

        // C) Fallback: any checked radio inside variant-radios
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

    // Shopify productId from placeholder
    var productId = "";
    try {
      productId = (host.getAttribute("data-product-id") || "").trim();
    } catch (_) {}

    // Optional legacy club handle
    var clubHandle = "";
    try {
      clubHandle = (host.getAttribute("data-club-handle") || "").trim();
    } catch (_) {}

    // Embed widget
    var iframe = document.createElement("iframe");
    iframe.src =
      baseUrl +
      "/embed/widget-demo" +
      "?productId=" +
      encodeURIComponent(productId || "") +
      "&club=" +
      encodeURIComponent(clubHandle || "");
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
              productId: productId || "",
            },
            "*"
          );
      } catch (_) {}
    }

    // Dawn sometimes updates checked state slightly after the event
    var sendTimer = null;
    function scheduleSendVariantState() {
      try {
        if (sendTimer) clearTimeout(sendTimer);
        sendTimer = setTimeout(function () {
          sendVariantState();
        }, 180);
      } catch (_) {
        sendVariantState();
      }
    }

    iframe.addEventListener("load", function () {
      // Give the product form time to fully initialise
      setTimeout(sendVariantState, 250);
    });

    function isInVariantArea(target) {
      if (!target || !target.closest) return false;
      return (
        target.closest("variant-radios") ||
        target.closest("variant-selects") ||
        target.closest(".product-form") ||
        target.closest("product-info")
      );
    }

    // Listen to both change + click so pills are captured reliably
    document.addEventListener("change", function (e) {
      var t = e && e.target;
      if (isInVariantArea(t)) scheduleSendVariantState();
    });

    document.addEventListener("click", function (e) {
      var t = e && e.target;
      if (isInVariantArea(t)) scheduleSendVariantState();
    });

    // Widget -> Shopify messages
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
