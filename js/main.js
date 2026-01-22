// Project Bantay Bayan · Uplink Monitor
// Data files expected in same folder as index.html:
// - Barangays.csv  (columns: brgy_id, barangay, lat, lon, city, city_id)
// - Cities.csv     (columns: city, city_id, lat, lon, province, province_id)
// - Provinces.csv  (columns: province, province_id, lat, lon)
//
// Behavior:
// - All nodes (province/city/barangay) have a checkbox (default checked).
// - Markers remain visible when unchecked, but turn grey ("Disabled").
// - Connecting lines are shown/hidden based on checkbox rules:
//   * Barangay unchecked: hide barangay→city line.
//   * City unchecked: hide all lines involving the city (barangay→city and city→province).
//   * Province unchecked: hide city→province lines for its cities, but barangay→city lines remain for checked barangays and checked cities.
// - Rows without valid coordinates are skipped for markers and any links requiring them.
// - Clicking a name zooms/pans to its marker.

(() => {
  const FILES = {
    barangays: "Barangays.csv",
    cities: "Cities.csv",
    provinces: "Provinces.csv"
  };

  // Zoom presets
  const ZOOM = { province: 10, city: 12, barangay: 15 };

  const treeEl = document.getElementById("tree");

  function setStatus(msg, cls) {
    const el = document.getElementById("status");
    if (!el) return;
    el.textContent = msg;
    el.className = "status" + (cls ? " " + cls : "");
  }

  function toNum(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }

  function normalizeId(x) {
    const s = (x ?? "").toString().trim();
    return s.length ? s : null;
  }

  async function fetchCsv(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`);
    const text = await res.text();
    const parsed = Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false
    });
    if (parsed.errors && parsed.errors.length) {
      console.warn("CSV parse errors for", url, parsed.errors);
    }
    return parsed.data || [];
  }

  // --------------------
  // Leaflet map setup
  // --------------------
  const map = L.map("map", { zoomControl: true, preferCanvas: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  // Default marker icons (use local Leaflet images)
  const brgyIconEnabled = new L.Icon({
    iconUrl: "./css/images/marker-icon.png",
    shadowUrl: "./css/images/marker-shadow.png",
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
    shadowSize: [41, 41],
    className: "" // normal
  });

  const brgyIconDisabled = new L.Icon({
    iconUrl: "./css/images/marker-icon.png",
    shadowUrl: "./css/images/marker-shadow.png",
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
    shadowSize: [41, 41],
    className: "marker-disabled"
  });

  // Awesome marker icons for cities/provinces (local CSS + fontawesome already loaded)
  const cityIconEnabled = L.AwesomeMarkers.icon({
    icon: "city",
    prefix: "fa",
    markerColor: "green",
    iconColor: "white"
  });
  const provinceIconEnabled = L.AwesomeMarkers.icon({
    icon: "landmark",
    prefix: "fa",
    markerColor: "red",
    iconColor: "white"
  });
  const disabledAwesome = L.AwesomeMarkers.icon({
    icon: "ban",
    prefix: "fa",
    markerColor: "gray",
    iconColor: "white"
  });

  // Layers
  const layerBrgy = L.layerGroup().addTo(map);
  const layerCity = L.layerGroup().addTo(map);
  const layerProv = L.layerGroup().addTo(map);
  const layerLinks = L.layerGroup().addTo(map);

  // --------------------
  // State and indexes
  // --------------------
  const enabled = {
    province: new Map(), // province_id -> bool
    city: new Map(),     // city_id -> bool
    barangay: new Map()  // brgy_id -> bool
  };

  const markers = {
    province: new Map(), // province_id -> marker
    city: new Map(),     // city_id -> marker
    barangay: new Map()  // brgy_id -> marker
  };

  // Link objects
  // brgyId -> antPath polyline (barangay->city)
  const linkBrgyToCity = new Map();
  // cityId -> antPath polyline (city->province)
  const linkCityToProv = new Map();

  // Data caches (only rows with coords are used for markers)
  let barangays = [];
  let cities = [];
  let provinces = [];

  const cityById = new Map();       // only with coords
  const provinceById = new Map();   // only with coords
  const barangaysByCity = new Map();// city_id -> array of barangays (may include without coords, but links require coords)

  function setAllEnabled(type, val) {
    enabled[type].forEach((_, id) => enabled[type].set(id, val));
  }

  function getEnabled(type, id) {
    return enabled[type].get(id) !== false; // default true if missing
  }

  function setEnabled(type, id, val) {
    enabled[type].set(id, !!val);
  }

  // --------------------
  // UI build
  // --------------------
  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    });
    children.forEach(c => e.appendChild(c));
    return e;
  }

  function buildTree() {
    treeEl.innerHTML = "";

    // provinces list (sorted by name)
    const provList = [...provinces].sort((a,b) => (a.province||"").localeCompare(b.province||""));
    provList.forEach(p => {
      const provId = p.province_id;
      const provLi = el("li");
      const provRow = buildNodeRow("province", provId, p.province || "(Unnamed province)", () => zoomTo("province", provId));
      provLi.appendChild(provRow);

      // Cities under province
      const ulCities = el("ul");
      const citiesInProv = cities
        .filter(c => c.province_id === provId)
        .sort((a,b) => (a.city||"").localeCompare(b.city||""));

      citiesInProv.forEach(c => {
        const cityId = c.city_id;
        const cityLi = el("li");
        const cityRow = buildNodeRow("city", cityId, c.city || "(Unnamed city)", () => zoomTo("city", cityId));
        cityLi.appendChild(cityRow);

        // Barangays under city (from Barangays.csv by city_id)
        const ulBrgy = el("ul");
        const bList = (barangaysByCity.get(cityId) || [])
          .slice()
          .sort((a,b) => (a.barangay||"").localeCompare(b.barangay||""));

        bList.forEach(b => {
          const bId = b.brgy_id;
          const bLi = el("li");
          const bRow = buildNodeRow("barangay", bId, b.barangay || "(Unnamed barangay)", () => zoomTo("barangay", bId));
          bLi.appendChild(bRow);
          ulBrgy.appendChild(bLi);
        });

        cityLi.appendChild(ulBrgy);
        ulCities.appendChild(cityLi);
      });

      provLi.appendChild(ulCities);
      treeEl.appendChild(provLi);
    });
  }

  function buildNodeRow(type, id, labelText, onZoom) {
    const cb = el("input", { type: "checkbox" });
    cb.checked = getEnabled(type, id);
    cb.addEventListener("change", () => {
      setEnabled(type, id, cb.checked);
      applyVisibilityRules();
      updateMarkerStyles();
    });

    const btn = el("button", { class: "label", type: "button", text: labelText, onclick: onZoom });
    const meta = el("span", { class: "meta", text: "" });

    // meta counts (computed later for city/prov)
    if (type === "province") {
      const nCities = cities.filter(c => c.province_id === id).length;
      meta.textContent = `${nCities} cities`;
    } else if (type === "city") {
      const nB = (barangaysByCity.get(id) || []).length;
      meta.textContent = `${nB} brgys`;
    }

    return el("div", { class: "node" }, [cb, btn, meta]);
  }

  // --------------------
  // Markers + links
  // --------------------
  function clearMapObjects() {
    layerBrgy.clearLayers();
    layerCity.clearLayers();
    layerProv.clearLayers();
    layerLinks.clearLayers();

    markers.province.clear();
    markers.city.clear();
    markers.barangay.clear();

    linkBrgyToCity.clear();
    linkCityToProv.clear();
  }

  function addMarkersAndLinks() {
    clearMapObjects();

    // Provinces (markers only if coords exist)
    provinces.forEach(p => {
      if (p.lat == null || p.lon == null) return;
      const m = L.marker([p.lat, p.lon], { icon: provinceIconEnabled })
        .bindPopup(`<b>Province:</b> ${p.province ?? ""}<br/><b>province_id:</b> ${p.province_id ?? ""}`);
      m.addTo(layerProv);
      markers.province.set(p.province_id, m);
    });

    // Cities
    cities.forEach(c => {
      if (c.lat == null || c.lon == null) return;
      const m = L.marker([c.lat, c.lon], { icon: cityIconEnabled })
        .bindPopup(`<b>City:</b> ${c.city ?? ""}<br/><b>city_id:</b> ${c.city_id ?? ""}<br/><b>Province:</b> ${c.province ?? ""}`);
      m.addTo(layerCity);
      markers.city.set(c.city_id, m);
    });

    // Barangays
    barangays.forEach(b => {
      if (b.lat == null || b.lon == null) return;
      const m = L.marker([b.lat, b.lon], { icon: brgyIconEnabled })
        .bindPopup(`<b>Barangay:</b> ${b.barangay ?? ""}<br/><b>brgy_id:</b> ${b.brgy_id ?? ""}<br/><b>City:</b> ${b.city ?? ""}`);
      m.addTo(layerBrgy);
      markers.barangay.set(b.brgy_id, m);
    });

    // Links (only if both endpoints have coords and markers exist)
    // barangay -> city
    barangays.forEach(b => {
      if (b.lat == null || b.lon == null) return;
      if (!b.city_id) return;
      const c = cityById.get(b.city_id);
      if (!c || c.lat == null || c.lon == null) return;

      const line = L.polyline.antPath([[b.lat, b.lon], [c.lat, c.lon]], {
        color: "#2A81CB",
        delay: 1000,
        dashArray: [10, 18],
        weight: 2,
        opacity: 0.75,
        renderer: L.svg({ pane: "overlayPane" })
      });
      line.addTo(layerLinks);
      linkBrgyToCity.set(b.brgy_id, line);
    });

    // city -> province
    cities.forEach(c => {
      if (c.lat == null || c.lon == null) return;
      if (!c.province_id) return;
      const p = provinceById.get(c.province_id);
      if (!p || p.lat == null || p.lon == null) return;

      const line = L.polyline.antPath([[c.lat, c.lon], [p.lat, p.lon]], {
        color: "#CB2B3E",
        delay: 1000,
        dashArray: [12, 22],
        weight: 3,
        opacity: 0.75,
        renderer: L.svg({ pane: "overlayPane" })
      });
      line.addTo(layerLinks);
      linkCityToProv.set(c.city_id, line);
    });

    updateMarkerStyles();
    applyVisibilityRules();
  }

  function updateMarkerStyles() {
    // Province markers: enabled => red landmark, disabled => grey
    markers.province.forEach((m, provId) => {
      const on = getEnabled("province", provId);
      m.setIcon(on ? provinceIconEnabled : disabledAwesome);
    });

    // City markers: enabled => green city, disabled => grey
    markers.city.forEach((m, cityId) => {
      const on = getEnabled("city", cityId);
      m.setIcon(on ? cityIconEnabled : disabledAwesome);
    });

    // Barangay markers: enabled => blue default, disabled => grey filtered default
    markers.barangay.forEach((m, brgyId) => {
      const on = getEnabled("barangay", brgyId);
      m.setIcon(on ? brgyIconEnabled : brgyIconDisabled);
    });
  }

  function showLine(line, yes) {
    if (!line) return;
    const isOnMap = layerLinks.hasLayer(line);
    if (yes && !isOnMap) line.addTo(layerLinks);
    if (!yes && isOnMap) layerLinks.removeLayer(line);
  }

  function applyVisibilityRules() {
    // barangay -> city visibility
    linkBrgyToCity.forEach((line, brgyId) => {
      const b = barangays.find(x => x.brgy_id === brgyId);
      if (!b) return;

      const brgyOn = getEnabled("barangay", brgyId);
      const cityOn = b.city_id ? getEnabled("city", b.city_id) : true;

      // Rule: if city unchecked, disconnect all barangays
      const visible = brgyOn && cityOn;
      showLine(line, visible);
    });

    // city -> province visibility
    linkCityToProv.forEach((line, cityId) => {
      const c = cityById.get(cityId);
      if (!c) return;

      const cityOn = getEnabled("city", cityId);

      // Rule: province unchecked disconnect city->province, but city->barangay unaffected
      const provOn = c.province_id ? getEnabled("province", c.province_id) : true;

      // Rule: if city unchecked, disconnect city->province
      const visible = cityOn && provOn;
      showLine(line, visible);
    });
  }

  function zoomTo(type, id) {
    const m = markers[type].get(id);
    if (!m) return;
    const ll = m.getLatLng();
    const z = ZOOM[type] ?? map.getZoom();
    map.setView(ll, z, { animate: true });
    // open popup for quick confirmation
    try { m.openPopup(); } catch (_) {}
  }

  function fitBoundsToData() {
    const ll = [];
    markers.barangay.forEach(m => ll.push(m.getLatLng()));
    markers.city.forEach(m => ll.push(m.getLatLng()));
    markers.province.forEach(m => ll.push(m.getLatLng()));
    if (ll.length) map.fitBounds(ll, { padding: [40, 40] });
    else map.setView([10.3169, 123.89], 10);
  }

  // --------------------
  // Main
  // --------------------
  async function main() {
    try {
      if (location.protocol === "file:") {
        setStatus("Open via a local web server (not file://). Example: `python -m http.server` then open http://localhost:8000/", "err");
      }

      setStatus("Fetching CSV files…");

      const [barangaysRaw, citiesRaw, provincesRaw] = await Promise.all([
        fetchCsv(FILES.barangays),
        fetchCsv(FILES.cities),
        fetchCsv(FILES.provinces)
      ]);

      // Normalize and skip rows without coords for marker/link generation
      const barangaysAll = barangaysRaw.map(r => ({
        ...r,
        brgy_id: normalizeId(r.brgy_id),
        city_id: normalizeId(r.city_id),
        barangay: (r.barangay ?? "").toString().trim(),
        city: (r.city ?? "").toString().trim(),
        lat: toNum(r.lat),
        lon: toNum(r.lon)
      })).filter(r => r.brgy_id && r.city_id && r.lat && r.lon);

      const citiesAll = citiesRaw.map(r => ({
        ...r,
        city_id: normalizeId(r.city_id),
        province_id: normalizeId(r.province_id),
        city: (r.city ?? "").toString().trim(),
        province: (r.province ?? "").toString().trim(),
        lat: toNum(r.lat),
        lon: toNum(r.lon)
      })).filter(r => r.city_id);

      const provincesAll = provincesRaw.map(r => ({
        ...r,
        province_id: normalizeId(r.province_id),
        province: (r.province ?? "").toString().trim(),
        lat: toNum(r.lat),
        lon: toNum(r.lon)
      })).filter(r => r.province_id);

      // Keep full lists for tree; coords may be null
      barangays = barangaysAll;
      cities = citiesAll;
      provinces = provincesAll;

      // Build indexes of entities with coords for linking/markers
      cityById.clear();
      citiesAll.forEach(c => {
        if (c.lat != null && c.lon != null) cityById.set(c.city_id, c);
      });

      provinceById.clear();
      provincesAll.forEach(p => {
        if (p.lat != null && p.lon != null) provinceById.set(p.province_id, p);
      });

      barangaysByCity.clear();
      barangaysAll.forEach(b => {
        if (!barangaysByCity.has(b.city_id)) barangaysByCity.set(b.city_id, []);
        barangaysByCity.get(b.city_id).push(b);
      });

      // Init enabled state maps (default true)
      provincesAll.forEach(p => enabled.province.set(p.province_id, true));
      citiesAll.forEach(c => enabled.city.set(c.city_id, true));
      barangaysAll.forEach(b => enabled.barangay.set(b.brgy_id, true));

      // Build UI tree
      buildTree();

      // Add markers and links
      addMarkersAndLinks();
      fitBoundsToData();

      // Buttons: check all / uncheck all
      const btnCheckAll = document.getElementById("btnCheckAll");
      const btnUncheckAll = document.getElementById("btnUncheckAll");

      btnCheckAll?.addEventListener("click", () => {
        setAllEnabled("province", true);
        setAllEnabled("city", true);
        setAllEnabled("barangay", true);
        // update UI checkboxes
        treeEl.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
        applyVisibilityRules();
        updateMarkerStyles();
      });

      btnUncheckAll?.addEventListener("click", () => {
        setAllEnabled("province", false);
        setAllEnabled("city", false);
        setAllEnabled("barangay", false);
        treeEl.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
        applyVisibilityRules();
        updateMarkerStyles();
      });

      // Stats
      const brgyMarkers = markers.barangay.size;
      const cityMarkers = markers.city.size;
      const provMarkers = markers.province.size;

      const brgyWithCoords = barangaysAll.filter(b => b.lat != null && b.lon != null).length;
      const cityWithCoords = citiesAll.filter(c => c.lat != null && c.lon != null).length;
      const provWithCoords = provincesAll.filter(p => p.lat != null && p.lon != null).length;

      const skippedBrgy = barangaysAll.length - brgyWithCoords;
      const skippedCity = citiesAll.length - cityWithCoords;
      const skippedProv = provincesAll.length - provWithCoords;

      setStatus(
        `Loaded markers: ${brgyMarkers} barangays, ${cityMarkers} cities, ${provMarkers} provinces. ` +
        `Skipped (no coords): ${skippedBrgy} barangays, ${skippedCity} cities, ${skippedProv} provinces.`,
        "ok"
      );
    } catch (e) {
      console.error(e);
      setStatus("Error: " + e.message, "err");
    }
  }

  main();
})();
