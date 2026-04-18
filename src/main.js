import L from "leaflet";
import "leaflet/dist/leaflet.css";
import iconUrl from "leaflet/dist/images/marker-icon.png";
import iconRetinaUrl from "leaflet/dist/images/marker-icon-2x.png";
import shadowUrl from "leaflet/dist/images/marker-shadow.png";
import "./style.css";

L.Icon.Default.mergeOptions({
  iconUrl,
  iconRetinaUrl,
  shadowUrl,
});

const WIKI_GEO =
  "https://en.wikipedia.org/w/api.php?action=query&list=geosearch&format=json&origin=*";

const DEBOUNCE_MS = 550;
const MIN_RADIUS_M = 80;
const MAX_RADIUS_M = 50_000;
const GEO_LIMIT = 45;

function degToRad(d) {
  return (d * Math.PI) / 180;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = degToRad(lat1);
  const φ2 = degToRad(lat2);
  const Δφ = degToRad(lat2 - lat1);
  const Δλ = degToRad(lon2 - lon1);
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Search radius from map: ~distance from center to NE corner, clamped. */
function radiusFromMap(map) {
  const b = map.getBounds();
  const c = map.getCenter();
  if (!b || !c) return 2000;
  const ne = b.getNorthEast();
  const r = distanceMeters(c.lat, c.lng, ne.lat, ne.lng);
  return Math.round(
    Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, r * 1.05)),
  );
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function fetchNearbyLandmarks(lat, lon, radiusM) {
  const url = `${WIKI_GEO}&gscoord=${lat}|${lon}&gsradius=${radiusM}&gslimit=${GEO_LIMIT}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Landmarks request failed (${res.status})`);
  const data = await res.json();
  const items = data?.query?.geosearch ?? [];
  return items.map((item) => ({
    pageId: item.pageid,
    title: item.title,
    lat: item.lat,
    lon: item.lon,
  }));
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wikiArticleUrl(title) {
  const encoded = encodeURIComponent(title.replace(/ /g, "_"));
  return `https://en.wikipedia.org/wiki/${encoded}`;
}

/** iOS Safari only reliably starts speech during the user gesture; voices load async. */
function pickEnglishVoice() {
  const voices = window.speechSynthesis?.getVoices?.() ?? [];
  return (
    voices.find((v) => v.lang.startsWith("en-US")) ||
    voices.find((v) => v.lang.startsWith("en")) ||
    voices[0]
  );
}

function ensureVoicesLoaded() {
  if (!window.speechSynthesis) return;
  speechSynthesis.getVoices();
  speechSynthesis.onvoiceschanged = () => {
    speechSynthesis.getVoices();
  };
}

async function fetchIntroText(title) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&titles=${encodeURIComponent(title)}&format=json&origin=*`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Could not load article text.");
  const data = await res.json();
  const pages = data?.query?.pages;
  if (!pages) throw new Error("No article text.");
  const page = Object.values(pages)[0];
  if (page?.missing) throw new Error("Article not found.");
  let text = page?.extract || "";
  text = text.replace(/\[\d+\]/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > 1200) text = `${text.slice(0, 1200).trim()}…`;
  if (!text) throw new Error("No introduction text for this place.");
  return text;
}

function speakUtterance(text, onEnd, { cancelFirst = true } = {}) {
  if (!window.speechSynthesis) {
    onEnd?.();
    return;
  }
  if (cancelFirst) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.rate = 0.95;
  const voice = pickEnglishVoice();
  if (voice) u.voice = voice;
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  speechSynthesis.speak(u);
}

function createApp() {
  const app = document.querySelector("#app");
  if (!app) return;

  app.innerHTML = `
    <div class="map-shell">
      <div id="map" class="map" role="application" aria-label="Map"></div>
      <div class="map-overlay map-overlay--top">
        <p class="map-title">Tour Guide</p>
        <p class="map-hint" id="map-hint">Street map (not satellite). Zoom in to see blocks and building shapes. Use the layers control (top-right) to switch styles.</p>
      </div>
      <button type="button" class="btn-recenter" id="btn-recenter" title="Center on my location" aria-label="Center on my location">
        ⊕
      </button>
      <div class="landmark-sheet" id="landmark-sheet" hidden aria-hidden="true">
        <button type="button" class="landmark-sheet__backdrop" id="landmark-backdrop" tabindex="-1" aria-label="Close"></button>
        <div
          class="landmark-sheet__panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="landmark-sheet-title"
        >
          <header class="landmark-sheet__header">
            <h2 class="landmark-sheet__title" id="landmark-sheet-title"></h2>
            <button type="button" class="landmark-sheet__close" id="landmark-sheet-close" aria-label="Close">×</button>
          </header>
          <div class="landmark-sheet__body" id="landmark-sheet-body"></div>
          <footer class="landmark-sheet__footer">
            <button type="button" class="btn-listen" id="btn-listen" disabled>
              Listen to introduction
            </button>
            <button type="button" class="btn-stop-audio" id="btn-stop-speech" hidden>
              Stop audio
            </button>
          </footer>
        </div>
      </div>
    </div>
  `;

  ensureVoicesLoaded();

  const mapEl = app.querySelector("#map");
  const hintEl = app.querySelector("#map-hint");
  const btnRecenter = app.querySelector("#btn-recenter");
  const landmarkSheet = app.querySelector("#landmark-sheet");
  const landmarkBackdrop = app.querySelector("#landmark-backdrop");
  const landmarkTitle = app.querySelector("#landmark-sheet-title");
  const landmarkBody = app.querySelector("#landmark-sheet-body");
  const btnLandmarkClose = app.querySelector("#landmark-sheet-close");
  const btnListen = app.querySelector("#btn-listen");
  const btnStopSpeech = app.querySelector("#btn-stop-speech");

  let map;
  let userMarker;
  const landmarkMarkers = [];
  let userPos = null;
  let loadToken = 0;
  /** @type {string | null} */
  let currentIntroText = null;

  function clearLandmarkMarkers() {
    while (landmarkMarkers.length) {
      const m = landmarkMarkers.pop();
      map?.removeLayer(m);
    }
  }

  async function refreshLandmarks() {
    if (!map) return;
    const c = map.getCenter();
    const lat = c.lat;
    const lon = c.lng;
    const radiusM = radiusFromMap(map);
    const myToken = ++loadToken;

    hintEl.textContent = "Loading landmarks…";

    try {
      const raw = await fetchNearbyLandmarks(lat, lon, radiusM);
      if (myToken !== loadToken) return;

      clearLandmarkMarkers();

      for (const place of raw) {
        const marker = L.marker([place.lat, place.lon], {
          title: place.title,
        }).addTo(map);
        marker.on("click", () => onLandmarkClick(place));
        landmarkMarkers.push(marker);
      }

      hintEl.textContent = `${raw.length} place${raw.length === 1 ? "" : "s"} in view (~${formatRadius(radiusM)} search). Tap a pin for details.`;
    } catch (e) {
      if (myToken !== loadToken) return;
      hintEl.textContent =
        e instanceof Error ? e.message : "Could not load landmarks.";
    }
  }

  const debouncedRefresh = debounce(refreshLandmarks, DEBOUNCE_MS);

  function formatRadius(m) {
    if (m < 1000) return `${m} m`;
    return `${(m / 1000).toFixed(1)} km`;
  }

  function closeLandmarkSheet() {
    window.speechSynthesis?.cancel();
    currentIntroText = null;
    btnStopSpeech.hidden = true;
    landmarkSheet.hidden = true;
    landmarkSheet.setAttribute("aria-hidden", "true");
  }

  function openLandmarkSheet(place) {
    window.speechSynthesis?.cancel();
    btnStopSpeech.hidden = true;
    currentIntroText = null;
    landmarkTitle.textContent = place.title;
    landmarkBody.innerHTML =
      '<p class="landmark-sheet__loading">Loading information…</p>';
    btnListen.disabled = true;
    landmarkSheet.hidden = false;
    landmarkSheet.setAttribute("aria-hidden", "false");

    void (async () => {
      try {
        const text = await fetchIntroText(place.title);
        currentIntroText = text;
        landmarkBody.innerHTML = `
          <p class="landmark-sheet__intro">${escapeHtml(text)}</p>
          <p class="landmark-sheet__wiki">
            <a href="${wikiArticleUrl(place.title)}" target="_blank" rel="noopener noreferrer">Open full article on Wikipedia</a>
          </p>`;
        btnListen.disabled = !window.speechSynthesis;
        btnListen.title = window.speechSynthesis
          ? ""
          : "Speech is not available in this browser.";
      } catch (e) {
        const msg =
          e instanceof Error ? e.message : "Could not load information.";
        landmarkBody.innerHTML = `<p class="landmark-sheet__error">${escapeHtml(msg)}</p>`;
        btnListen.disabled = true;
        btnListen.title = "";
      }
    })();
  }

  function onLandmarkClick(place) {
    openLandmarkSheet(place);
  }

  btnLandmarkClose.addEventListener("click", closeLandmarkSheet);
  landmarkBackdrop.addEventListener("click", closeLandmarkSheet);

  btnListen.addEventListener("click", () => {
    if (!currentIntroText) return;
    btnStopSpeech.hidden = false;
    speakUtterance(currentIntroText, () => {
      btnStopSpeech.hidden = true;
    });
  });

  btnStopSpeech.addEventListener("click", () => {
    window.speechSynthesis?.cancel();
    btnStopSpeech.hidden = true;
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !landmarkSheet.hidden) {
      closeLandmarkSheet();
    }
  });

  function setUserMarkerPosition(lat, lng) {
    userPos = { lat, lng };
    if (!userMarker) return;
    userMarker.setLatLng([lat, lng]);
  }

  function recenterMap() {
    if (!map || !userPos) return;
    map.setView([userPos.lat, userPos.lng], Math.max(map.getZoom(), 15));
  }

  btnRecenter.addEventListener("click", recenterMap);

  function initMap(lat, lng, zoom) {
    map = L.map(mapEl, {
      zoomControl: true,
      maxZoom: 19,
    }).setView([lat, lng], zoom);

    const attrOsm =
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
    const attrCarto = `${attrOsm} &copy; <a href="https://carto.com/attributions">CARTO</a>`;

    // Carto "Voyager": street-focused; building footprints show in many areas when zoomed in (not 3D, not satellite).
    const streetsLayer = L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
      {
        maxZoom: 19,
        attribution: attrCarto,
      },
    );

    const standardLayer = L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        maxZoom: 19,
        attribution: attrOsm,
      },
    );

    streetsLayer.addTo(map);

    L.control.layers(
      {
        "Streets (buildings)": streetsLayer,
        "Standard": standardLayer,
      },
      null,
      { position: "topright", collapsed: true },
    ).addTo(map);

    userMarker = L.circleMarker([lat, lng], {
      radius: 10,
      fillColor: "#4285F4",
      color: "#ffffff",
      weight: 2,
      opacity: 1,
      fillOpacity: 1,
    }).addTo(map);
    userMarker.bindTooltip("Your location", { permanent: false });

    map.on("moveend", () => debouncedRefresh());

    if (navigator.geolocation) {
      navigator.geolocation.watchPosition(
        (pos) => {
          setUserMarkerPosition(
            pos.coords.latitude,
            pos.coords.longitude,
          );
        },
        () => {},
        {
          enableHighAccuracy: true,
          maximumAge: 5000,
          timeout: 15000,
        },
      );
    }
  }

  if (!navigator.geolocation) {
    initMap(20, 0, 2);
    hintEl.textContent =
      "Geolocation not available — drag and zoom to explore.";
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      initMap(pos.coords.latitude, pos.coords.longitude, 16);
    },
    () => {
      initMap(20, 0, 2);
      hintEl.textContent =
        "Location unavailable — allow access or browse the map manually.";
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
  );
}

createApp();
