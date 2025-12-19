// FILE: public/widget.js
(function () {
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_\-]/g, "\\$&");
  }

  function findGloboSelected() {
    try {
      var checked =
        document.querySelector('input[type="radio"][id^="swatch-detail-"]:checked') ||
        document.querySelector('input[type="radio"][id*="swatch-detail-"]:checked');

      if (!checked) return { size: "", variantId: "" };

      var id = checked.id || "";
      var m = id.match(/swatch-detail-(\d+)/i);
      var variantId = m && m[1] ? String(m[1]) : "";

      var label = document.querySelector('label[for="' + cssEscape(id) + '"]');
      var size = label && label.textContent ? label.textContent.trim() : "";

      if (!size) size = (checked.value || "").trim();

      return { size: size, variantId: variantId };
    } catch (_) {
      return { size: "", variantId: "" };
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

  function syncShopifyVariantInputs(variantId) {
    // IMPORTANT: set value ONLY - do NOT dispatch change/input events (prevents infinite loops)
    try {
      if (!variantId) return;
      var inputs = document.querySelectorAll(
        'form[action^="/cart/add"] input[name="id"], input.product-variant-id'
      );
      inputs.forEach(function (inp) {
        try {
          if ((inp.value || "") !== variantId) inp.value = variantId;
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

    var productId = "";
    try {
      productId = (host.getAttribute("data-product-id") || "").trim();
    } catch (_) {}

    var clubHandle = "";
    try {
      clubHandle = (host.getAttribute("data-club-handle") || "").trim();
    } catch (_) {}

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
      var globo = findGloboSelected();
      var variantId = findVariantIdFromUrl() || globo.variantId || "";
      var size = globo.size || "";
      return { size: size, variantId: variantId };
    }

    var scheduled = false;
    function scheduleSend() {
      if (scheduled) return;
      scheduled = true;
      setTimeout(function () {
        scheduled = false;
        sendNow();
      }, 50);
    }

    function sendNow() {
      try {
        var st = getVariantState();

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
      scheduleSend();
    });

    document.addEventListener("change", function (e) {
      var t = e && e.target;
      if (!t) return;

      // Ignore our own hidden variant id inputs entirely
      if (t.matches && (t.matches('input[name="id"]') || t.matches("input.product-variant-id"))) {
        return;
      }

      if (
        t.closest('[id*="swatch"]') ||
        t.closest('[class*="globo"]') ||
        t.closest(".product-form") ||
        t.closest("product-info")
      ) {
        scheduleSend();
      }
    });

    document.addEventListener("click", function (e) {
      var t = e && e.target;
      if (!t) return;

      if (
        (t.tagName === "LABEL" && (t.getAttribute("for") || "").indexOf("swatch-detail-") !== -1) ||
        t.closest('label[for^="swatch-detail-"]') ||
        t.closest('[class*="globo"]')
      ) {
        scheduleSend();
      }
    });

    window.addEventListener("message", function (event) {
      try {
        if (!event || !event.data) return;
        var data = event.data;

        if (data.type === "h2h:reservation:ready") {
          window.dispatchEvent(new CustomEvent("h2h:reservation:ready"));

          var input = document.getElementById("h2h_jersey_number");
          if (input) input.value = String(data.jerseyNumber);
        }

        if (data.type === "h2h:reservation:cleared") {
          window.dispatchEvent(new CustomEvent("h2h:reservation:cleared"));

          var input2 = document.getElementById("h2h_jersey_number");
          if (input2) input2.value = "";
        }
      } catch (_) {}
    });

    // initial sends (Globo sometimes loads late)
    setTimeout(scheduleSend, 500);
    setTimeout(scheduleSend, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
