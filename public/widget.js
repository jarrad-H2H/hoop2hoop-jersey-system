// FILE: public/widget.js
(function () {
  // Tiny CSS.escape fallback
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_\-]/g, "\\$&");
  }

  function findGloboSelected() {
    try {
      // Globo commonly uses radio inputs with ids like: swatch-detail-51653048434987-1-0
      var checked =
        document.querySelector('input[type="radio"][id^="swatch-detail-"]:checked') ||
        document.querySelector('input[type="radio"][id*="swatch-detail-"]:checked');

      if (!checked) return { size: "", variantId: "" };

      var id = checked.id || "";
      var m = id.match(/swatch-detail-(\d+)/i);
      var variantId = m && m[1] ? String(m[1]) : "";

      // Prefer the label text (it’s usually the size like "YL")
      var label = document.querySelector('label[for="' + cssEscape(id) + '"]');
      var size = label && label.textContent ? label.textContent.trim() : "";

      // Fallbacks
      if (!size) size = (checked.value || "").trim();

      return { size: size, variantId: variantId };
    } catch (_) {
      return { size: "", variantId: "" };
    }
  }

  function findDawnSelectedSize() {
    try {
      // 1) variant-selects dropdowns
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

      // 2) variant-radios buttons (Dawn size pills)
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

  function findVariantIdFromUrl() {
    try {
      var u = new URL(window.location.href);
      var v = u.searchParams.get("variant");
      return v ? String(v).trim() : "";
    } catch (_) {
      return "";
    }
  }

  function findVariantIdFromForms() {
    try {
      // Update: get ALL matching inputs (you have multiple forms)
      var inputs = document.querySelectorAll('form[action^="/cart/add"] input[name="id"], input.product-variant-id');
      if (!inputs || !inputs.length) return "";
      return (inputs[0].value || "").trim();
    } catch (_) {
      return "";
    }
  }

  function syncShopifyVariantInputs(variantId) {
    try {
      if (!variantId) return;
      var inputs = document.querySelectorAll('form[action^="/cart/add"] input[name="id"], input.product-variant-id');
      inputs.forEach(function (inp) {
        try {
          inp.value = variantId;
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        } catch (_) {}
      });
    } catch (_) {}
  }

  function mount() {
    var host =
      document.querySelector('[data-h2h-widget]') ||
      document.getElementById("h2h-jersey-widget");

    if (!host) return;

    if (host.getAttribute("data-h2h-mounted") === "true") return;
    host.setAttribute("data-h2h-mounted", "true");

    var baseUrl = new URL(document.currentScript.src).origin;

    // We will pass the Shopify Product ID to the iframe so it can lookup club via mapping table
    var productId = "";
    try {
      productId = (host.getAttribute("data-product-id") || "").trim();
    } catch (_) {}

    // Also keep club handle as a fallback (won’t be relied on if mapping exists)
    var clubHandle = "";
    try {
      clubHandle = (host.getAttribute("data-club-handle") || "").trim();
    } catch (_) {}

    // Embed the widget
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

    function getVariantState() {
      // 1) Globo (your store)
      var globo = findGloboSelected();
      var size = globo.size || "";

      // 2) Dawn fallback
      if (!size) size = findDawnSelectedSize();

      // variantId priority:
      var variantId =
        findVariantIdFromUrl() ||
        globo.variantId ||
        findVariantIdFromForms();

      return { size: size, variantId: variantId };
    }

    function sendVariantState() {
      try {
        var st = getVariantState();

        // Keep Shopify "id" inputs in sync (helps if Globo isn't updating them)
        if (st.variantId) syncShopifyVariantInputs(st.variantId);

        iframe.contentWindow &&
          iframe.contentWindow.postMessage(
            {
              type: "h2h:variantChanged",
              size: st.size,
              variantId: st.variantId,
              productId: productId || "",
            },
            "*"
          );
      } catch (_) {}
    }

    iframe.addEventListener("load", function () {
      sendVariantState();
    });

    // React to both change + click (Globo sometimes uses click without change)
    document.addEventListener("change", function (e) {
      var t = e && e.target;
      if (!t) return;
      if (
        t.closest("variant-radios") ||
        t.closest("variant-selects") ||
        t.closest(".product-form") ||
        t.closest("product-info") ||
        t.closest('[id*="swatch"]') ||
        t.closest('[class*="globo"]')
      ) {
        sendVariantState();
      }
    });

    document.addEventListener("click", function (e) {
      var t = e && e.target;
      if (!t) return;
      // Globo size pills are labels
      if (
        (t.tagName === "LABEL" && (t.getAttribute("for") || "").indexOf("swatch-detail-") !== -1) ||
        t.closest('label[for^="swatch-detail-"]') ||
        t.closest('[class*="globo"]')
      ) {
        // let Globo update DOM first
        setTimeout(sendVariantState, 0);
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

    // Send initial state after a short delay too (covers late-loading Globo)
    setTimeout(sendVariantState, 500);
    setTimeout(sendVariantState, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
