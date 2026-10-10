// map.js - safety map on the explore page.
// Leaflet + OpenStreetMap tiles (no API key needed). Markers start grey and
// turn green/yellow/red only after the user opens a place's safety details
// (lazy scoring - no extra SerpApi calls are made for the map itself).
(function () {
  let map = null;
  const markers = [];

  const GREY = "#a8a29e";
  function colorFor(score) {
    if (score >= 70) return "#16a34a"; // green
    if (score >= 40) return "#f59e0b"; // yellow
    return "#ef4444"; // red
  }
  // Marker colour straight from the Google star rating in the search results
  // (4.6 stars -> 92 -> green). No extra SerpApi calls for the map.
  // Replaced by the exact Travely score once details are opened.
  function proxyColor(rating) {
    if (!rating) return GREY; // no rating -> grey (unscored)
    return colorFor(Math.round(rating * 20));
  }

  function ensureMap() {
    if (map) return map;
    map = L.map("map", { scrollWheelZoom: false }).setView([20.5937, 78.9629], 5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);
    return map;
  }

  // Popup content is built with DOM APIs (never innerHTML) so place names
  // coming from SerpApi can never inject markup into the page.
  function popupContent(p, i) {
    const wrap = document.createElement("div");
    wrap.className = "map-pop";

    const name = document.createElement("strong");
    name.textContent = p.name;
    wrap.appendChild(name);

    if (p.rating) {
      const r = document.createElement("span");
      r.className = "map-pop-rating";
      r.textContent = "\u2605 " + p.rating;
      wrap.appendChild(r);
    }
    if (p.address) {
      const a = document.createElement("span");
      a.className = "map-pop-addr";
      a.textContent = p.address;
      wrap.appendChild(a);
    }

    const btn = document.createElement("button");
    btn.className = "btn";
    btn.type = "button";
    btn.textContent = "See safety details";
    btn.setAttribute("hx-get", "/place/safety");
    btn.setAttribute("hx-vals", JSON.stringify({ dataId: p.dataId, name: p.name, address: p.address }));
    btn.setAttribute("hx-target", "#details-" + i);
    btn.setAttribute("hx-swap", "innerHTML");
    btn.setAttribute("hx-indicator", "#details-spin-" + i);
    wrap.appendChild(btn);

    return wrap;
  }

  // Build markers from the place cards htmx just swapped into #results
  function renderFromResults(container) {
    const m = ensureMap();
    markers.forEach((mk) => m.removeLayer(mk));
    markers.length = 0;

    const bounds = [];
    container.querySelectorAll(".card").forEach((card) => {
      const lat = parseFloat(card.dataset.lat);
      const lng = parseFloat(card.dataset.lng);
      if (Number.isNaN(lat) || Number.isNaN(lng)) return; // no gps -> skip

      const p = {
        name: card.dataset.name || "Place",
        address: card.dataset.address || "",
        dataId: card.dataset.dataId || "",
        rating: parseFloat(card.dataset.rating) || null,
      };
      const i = Number(card.dataset.index);

      const marker = L.circleMarker([lat, lng], {
        radius: 9,
        color: proxyColor(p.rating),
        weight: 2,
        fillColor: proxyColor(p.rating),
        fillOpacity: 1,
      }).addTo(m);

      marker.bindPopup(() => popupContent(p, i));
      // htmx only wires up elements it has processed
      marker.on("click", () => htmx.process(marker.getPopup().getContent()));

      markers.push(marker);
      bounds.push([lat, lng]);
    });

    if (bounds.length) m.fitBounds(bounds, { padding: [36, 36], maxZoom: 12 });
    setTimeout(() => m.invalidateSize(), 100);
  }

  // After a safety-details swap, colour that place's marker by its score
  function recolorFromDetails(target) {
    const match = /^details-(\d+)$/.exec(target.id || "");
    if (!match) return;
    const marker = markers[Number(match[1])];
    if (!marker) return;
    const scoreEl = target.querySelector(".score-num");
    if (!scoreEl) return;
    const score = Number(scoreEl.textContent);
    if (!Number.isNaN(score)) {
      const c = colorFor(score);
      marker.setStyle({ color: c, fillColor: c });
    }
  }

  // Single hook for both flows
  document.body.addEventListener("htmx:afterSwap", (e) => {
    const t = e.detail.target;
    if (!t) return;
    if (t.id === "results") renderFromResults(t);
    else recolorFromDetails(t);
  });
})();
