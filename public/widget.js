// FILE: public/widget.js
(function () {
  function mount() {
    var host =
      document.querySelector('[data-h2h-widget]') ||
      document.getElementById('h2h-jersey-widget');

    if (!host) return;
    if (host.getAttribute('data-h2h-mounted') === 'true') return;
    host.setAttribute('data-h2h-mounted', 'true');

    var baseUrl = new URL(document.currentScript.src).origin;

    // Read context from Shopify element
    var clubHandle = host.getAttribute('data-club-handle') || '';
    var productId = host.getAttribute('data-product-id') || '';
    var variantId = host.getAttribute('data-variant-id') || '';

    var qs = new URLSearchParams();
    if (clubHandle) qs.set('club', clubHandle);
    if (productId) qs.set('productId', productId);
    if (variantId) qs.set('variantId', variantId);

    var iframe = document.createElement('iframe');
    iframe.src = baseUrl + '/embed/widget-demo?' + qs.toString();
    iframe.style.width = '100%';
    iframe.style.border = '0';
    iframe.style.minHeight = '520px';
    iframe.setAttribute('loading', 'lazy');

    host.appendChild(iframe);

    window.addEventListener('message', function (event) {
      try {
        if (!event || !event.data) return;
        var data = event.data;

        if (data.type === 'h2h:reservation:ready') {
          window.dispatchEvent(new CustomEvent('h2h:reservation:ready'));

          var input = document.getElementById('h2h_jersey_number');
          if (input) input.value = String(data.jerseyNumber);

          if (input) {
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }

        if (data.type === 'h2h:reservation:cleared') {
          window.dispatchEvent(new CustomEvent('h2h:reservation:cleared'));

          var input2 = document.getElementById('h2h_jersey_number');
          if (input2) input2.value = "";

          if (input2) {
            input2.dispatchEvent(new Event('input', { bubbles: true }));
            input2.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      } catch (_) {}
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
