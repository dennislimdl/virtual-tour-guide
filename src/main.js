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

function speakIntro(text, onEnd) {
  if (!window.speechSynthesis) {
    onEnd?.();
    return;
  }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.95;
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  window.speechSynthesis.speak(u);
}

function createApp() {
  const app = document.querySelector("#app");
  if (!app) return;

  app.innerHTML = `
    <div class="map-shell">
      <div id="map" class="map" role="application" aria-label="Map"></div>
      <div class="map-overlay map-overlay--top">
        <p class="map-title">Tour Guide</p>
        <p class="map-hint" id="map-hint">Free map (OpenStreetMap). Pan or zoom — landmarks match the visible area.</p>
      </div>
      <button type="button" class="btn-recenter" id="btn-recenter" title="Center on my location" aria-label="Center on my location">
        ⊕
      </button>
      <div class="audio-bar" id="audio-bar" hidden>
        <span class="audio-bar__icon" aria-hidden="true">🔊</span>
        <p class="audio-bar__text" id="audio-bar-text"></p>
        <button type="button" class="btn-stop" id="btn-stop-audio" aria-label="Stop speaking">Stop</button>
      </div>
    </div>
  `;

  const mapEl = app.querySelector("#map");
  const hintEl = app.querySelector("#map-hint");
  const audioBar = app.querySelector("#audio-bar");
  const audioText = app.querySelector("#audio-bar-text");
  const btnRecenter = app.querySelector("#btn-recenter");
  const btnStop = app.querySelector("#btn-stop-audio");

  let map;
  let userMarker;
  const landmarkMarkers = [];
  let userPos = null;
  let loadToken = 0;

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

      hintEl.textContent = `${raw.length} place${raw.length === 1 ? "" : "s"} in view (~${formatRadius(radiusM)} search). Tap a pin for audio.`;
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

  async function onLandmarkClick(place) {
    window.speechSynthesis?.cancel();
    audioBar.hidden = false;
    audioText.textContent = `${place.title} — loading…`;

    try {
      const text = await fetchIntroText(place.title);
      audioText.textContent = place.title;
      speakIntro(text, () => {
        audioBar.hidden = true;
      });
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : "Could not read introduction.";
      audioText.textContent = msg;
      speakIntro(`Sorry. ${msg}`);
    }
  }

  btnStop.addEventListener("click", () => {
    window.speechSynthesis?.cancel();
    audioBar.hidden = true;
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
    map = L.map(mapEl, { zoomControl: true }).setView([lat, lng], zoom);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

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
