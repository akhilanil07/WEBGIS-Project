const map = L.map("map", {
  zoomControl: true,
  preferCanvas: true
}).setView([40.73, -73.94], 11);

L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
}).addTo(map);

const metricSelect = document.getElementById("metricSelect");
const metricNote = document.getElementById("metricNote");
const infoPanel = document.getElementById("infoPanel");
const legendContainer = document.getElementById("legend");
const profileModal = document.getElementById("profileModal");
const profileButtons = document.querySelectorAll(".profile-btn");
const skipProfileBtn = document.getElementById("skipProfileBtn");

const reversedMetrics = new Set(["mta_avgtm", "mta_mintm", "facilities_avgtm", "schools_avgtm", "healthy_avgtm", "athletic_avgtm"]);
const weightedModeField = "movesmart_score";

let ntaLayer = null;
let ntaData = null;
let pointLayers = {};
let selectedProfile = null;
let highlightedRecommendation = null;
let tooltipEl = null;
let activeBorough = "all";

const profileWeights = {
  commuter: {
    label: "Commuter",
    mta_count: 0.45,
    schools_count: 0.05,
    healthy_count: 0.10,
    facilities_count: 0.10,
    athletic_count: 0.05,
    mta_avgtm: 0.25
  },
  family: {
    label: "Family",
    mta_count: 0.15,
    schools_count: 0.35,
    healthy_count: 0.10,
    facilities_count: 0.25,
    athletic_count: 0.05,
    mta_avgtm: 0.10
  },
  active: {
    label: "Active Lifestyle",
    mta_count: 0.15,
    schools_count: 0.05,
    healthy_count: 0.20,
    facilities_count: 0.10,
    athletic_count: 0.35,
    mta_avgtm: 0.15
  }
};

const layerConfig = [
  {
    key: "mta",
    url: "webmap_data/mta_stations.geojson",
    toggleId: "toggleMTA",
    color: "#56ccf2",
    labelFieldCandidates: ["name", "station", "Station", "NAME"]
  },
  {
    key: "facilities",
    url: "webmap_data/facilities.geojson",
    toggleId: "toggleFacilities",
    color: "#bb6bd9",
    labelFieldCandidates: ["facname", "name", "NAME"]
  },
  {
    key: "athletic",
    url: "webmap_data/athletic_facilities.geojson",
    toggleId: "toggleAthletic",
    color: "#00ffa3",
    labelFieldCandidates: ["primary_sp", "featuresta", "name", "NAME"]
  },
  {
    key: "healthy",
    url: "webmap_data/healthy_stores.geojson",
    toggleId: "toggleHealthy",
    color: "#f2994a",
    labelFieldCandidates: ["name", "store_name", "NAME"]
  },
  {
    key: "schools",
    url: "webmap_data/schools.geojson",
    toggleId: "toggleSchools",
    color: "#eb5757",
    labelFieldCandidates: ["name", "school", "schoolname", "NAME"]
  }
];

// Wire up profile modal immediately — independent of data loading
profileButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    applyProfile(btn.dataset.profile);
  });
});

skipProfileBtn.addEventListener("click", () => {
  profileModal.classList.add("hidden");
  metricSelect.value = "mta_count";
  refreshNeighborhoodStyle();
  updateMetricNote();
  updateLegend();
});

init();

async function init() {
  try {
    const ntaResponse = await fetch("webmap_data/nta_accessibility.geojson");
    if (!ntaResponse.ok) {
      throw new Error(`Failed to load nta_accessibility.geojson: ${ntaResponse.status}`);
    }

    ntaData = await ntaResponse.json();

    ntaLayer = L.geoJSON(ntaData, {
      style: styleNeighborhood,
      onEachFeature: onEachNeighborhood
    }).addTo(map);

    const ntaBounds = ntaLayer.getBounds();
    if (ntaBounds.isValid()) {
      map.fitBounds(ntaBounds, { padding: [20, 20] });
    }

    await loadPointLayers();

    metricSelect.addEventListener("change", () => {
      clearRecommendationHighlight();
      refreshNeighborhoodStyle();
      updateMetricNote();
      updateLegend();
      updateCityStats();
    });


    updateMetricNote();
    updateLegend();
    updateCityStats();

    tooltipEl = document.createElement("div");
    tooltipEl.className = "map-tooltip";
    document.body.appendChild(tooltipEl);

    initSearch();
    initBoroughFilter();

    document.getElementById("changeProfileBtn")?.addEventListener("click", () => {
      profileModal.classList.remove("hidden");
    });
  } catch (error) {
    console.error("INIT ERROR:", error);
    infoPanel.innerHTML = `<p>Failed to load map data.<br>${escapeHtml(String(error.message))}</p>`;
  }
}

async function loadPointLayers() {
  for (const cfg of layerConfig) {
    try {
      const response = await fetch(cfg.url);
      if (!response.ok) {
        console.warn(`Skipping ${cfg.key}. Could not load ${cfg.url}`);
        continue;
      }

      const data = await response.json();
      const cleaned = filterValidPointFeatures(data);

      const layer = L.geoJSON(cleaned, {
        pointToLayer: (feature, latlng) => {
          return L.circleMarker(latlng, {
            radius: 5,
            fillColor: cfg.color,
            color: "#ffffff",
            weight: 1,
            opacity: 0.95,
            fillOpacity: 0.85
          });
        },
        onEachFeature: (feature, layerItem) => {
          const props = feature.properties || {};
          const label = pickFirstExisting(props, cfg.labelFieldCandidates) || cfg.key;

          const popupHtml = `
            <div>
              <div class="popup-title">${escapeHtml(String(label))}</div>
              <div class="popup-grid">
                ${buildPopupRows(props, 6)}
              </div>
            </div>
          `;
          layerItem.bindPopup(popupHtml);
        }
      });

      pointLayers[cfg.key] = layer;

      const toggle = document.getElementById(cfg.toggleId);
      if (toggle.checked) {
        layer.addTo(map);
      }

      toggle.addEventListener("change", (e) => {
        if (e.target.checked) {
          layer.addTo(map);
        } else {
          map.removeLayer(layer);
        }
      });
    } catch (error) {
      console.error(`Error loading layer ${cfg.key}:`, error);
    }
  }
}

function applyProfile(profileKey) {
  selectedProfile = profileKey;
  computeMoveSmartScores(profileWeights[profileKey]);
  metricSelect.value = weightedModeField;
  profileModal.classList.add("hidden");
  refreshNeighborhoodStyle();
  updateMetricNote();
  updateLegend();
  highlightBestNeighborhood();
  showTop5(profileKey);
  updateCityStats();
}

function computeMoveSmartScores(weights) {
  const metrics = ["mta_count", "schools_count", "healthy_count", "facilities_count", "athletic_count", "mta_avgtm"];
  const stats = {};

  metrics.forEach((metric) => {
    const values = ntaData.features
      .map((f) => getNumericValue(f.properties, metric))
      .filter((v) => Number.isFinite(v));

    stats[metric] = {
      min: Math.min(...values),
      max: Math.max(...values)
    };
  });

  ntaData.features.forEach((feature) => {
    const props = feature.properties || {};
    let score = 0;

    metrics.forEach((metric) => {
      const value = getNumericValue(props, metric);
      if (!Number.isFinite(value)) return;

      const min = stats[metric].min;
      const max = stats[metric].max;
      let normalized = 0;

      if (max !== min) {
        normalized = (value - min) / (max - min);
      }

      if (metric === "mta_avgtm") {
        normalized = 1 - normalized;
      }

      const weight = weights[metric] || 0;
      score += normalized * weight;
    });

    props.movesmart_score = Number((score * 100).toFixed(2));
  });
}

function highlightBestNeighborhood() {
  clearRecommendationHighlight();

  let bestLayer = null;
  let bestScore = -Infinity;

  ntaLayer.eachLayer((layer) => {
    const score = getNumericValue(layer.feature.properties, weightedModeField);
    if (Number.isFinite(score) && score > bestScore) {
      bestScore = score;
      bestLayer = layer;
    }
  });

  if (!bestLayer) return;

  highlightedRecommendation = bestLayer;
  bestLayer.setStyle({ color: "#00ffa3", weight: 3.5, fillOpacity: 0.9 });

  if (bestLayer.getBounds) {
    map.fitBounds(bestLayer.getBounds(), { padding: [60, 60] });
  }
}

function clearRecommendationHighlight() {
  if (highlightedRecommendation && ntaLayer) {
    ntaLayer.resetStyle(highlightedRecommendation);
    highlightedRecommendation = null;
  }
}

function filterValidPointFeatures(geojson) {
  if (!geojson || !Array.isArray(geojson.features)) {
    return { type: "FeatureCollection", features: [] };
  }

  const validFeatures = geojson.features.filter((feature) => {
    if (!feature || !feature.geometry) return false;
    if (feature.geometry.type !== "Point") return false;

    const coords = feature.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return false;

    const [lng, lat] = coords;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;

    return true;
  });

  return {
    type: "FeatureCollection",
    features: validFeatures
  };
}

function styleNeighborhood(feature) {
  const metric = metricSelect.value;
  const value = getNumericValue(feature.properties, metric);
  const boro = feature.properties?.boroname || "";
  const dimmed = activeBorough !== "all" && boro !== activeBorough;

  return {
    color: dimmed ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.18)",
    weight: dimmed ? 0.5 : 1.1,
    fillColor: getColorForValue(value, metric),
    fillOpacity: dimmed ? 0.07 : 0.72
  };
}

function onEachNeighborhood(feature, layer) {
  layer.on({
    mouseover: (e) => {
      const target = e.target;
      target.setStyle({ weight: 2, color: "#ffffff", fillOpacity: 0.86 });
      if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) {
        target.bringToFront();
      }
    },
    mousemove: (e) => {
      if (!tooltipEl) return;
      const metric = metricSelect.value;
      const value = getNumericValue(feature.properties, metric);
      const name = pickFirstExisting(feature.properties, ["ntaname", "NTAName", "NTA_NAME", "name", "Name"]) || "Neighborhood";
      const metricLabel = metricSelect.options[metricSelect.selectedIndex]?.text || metric;
      const displayVal = reversedMetrics.has(metric)
        ? formatMinutes(feature.properties[metric])
        : (value !== null ? (metric === weightedModeField ? value.toFixed(1) : String(Math.round(value))) : "N/A");
      tooltipEl.innerHTML = `<strong>${escapeHtml(String(name))}</strong>${escapeHtml(metricLabel)}: ${escapeHtml(displayVal)}`;
      tooltipEl.style.left = (e.originalEvent.clientX + 14) + "px";
      tooltipEl.style.top = (e.originalEvent.clientY - 8) + "px";
      tooltipEl.style.display = "block";
    },
    mouseout: () => {
      if (ntaLayer && layer !== highlightedRecommendation) {
        ntaLayer.resetStyle(layer);
      }
      if (tooltipEl) tooltipEl.style.display = "none";
    },
    click: () => {
      const props = feature.properties || {};
      updateInfoPanel(props);

      const neighborhoodName =
        pickFirstExisting(props, ["ntaname", "NTAName", "NTA_NAME", "name", "Name"]) ||
        "Neighborhood";

      const popupHtml = `
        <div>
          <div class="popup-title">${escapeHtml(String(neighborhoodName))}</div>
          <div class="popup-grid">
            <div class="label">MoveSmart Score</div><div>${safeValue(props.movesmart_score)}</div>
            <div class="label">Transit access</div><div>${safeValue(props.mta_count)}</div>
            <div class="label">School access</div><div>${safeValue(props.schools_count)}</div>
            <div class="label">Healthy stores</div><div>${safeValue(props.healthy_count)}</div>
            <div class="label">Community services</div><div>${safeValue(props.facilities_count)}</div>
            <div class="label">Sports & fitness</div><div>${safeValue(props.athletic_count)}</div>
            <div class="label">Avg walk to transit</div><div>${formatMinutes(props.mta_avgtm)}</div>
            <div class="label">Min walk to transit</div><div>${formatMinutes(props.mta_mintm)}</div>
          </div>
        </div>
      `;

      layer.bindPopup(popupHtml).openPopup();
    }
  });
}

function updateInfoPanel(props) {
  const neighborhoodName =
    pickFirstExisting(props, ["ntaname", "NTAName", "NTA_NAME", "name", "Name"]) ||
    "Neighborhood";

  const badge = selectedProfile
    ? `<div class="recommendation-badge">Profile: ${escapeHtml(profileWeights[selectedProfile].label)}</div>`
    : "";

  infoPanel.innerHTML = `
    <h3>${escapeHtml(String(neighborhoodName))}</h3>
    ${badge}
    <ul>
      <li><strong>MoveSmart Score:</strong> ${safeValue(props.movesmart_score)}</li>
      <li><strong>Transit access:</strong> ${safeValue(props.mta_count)}</li>
      <li><strong>School access:</strong> ${safeValue(props.schools_count)}</li>
      <li><strong>Healthy stores:</strong> ${safeValue(props.healthy_count)}</li>
      <li><strong>Community services:</strong> ${safeValue(props.facilities_count)}</li>
      <li><strong>Sports & fitness:</strong> ${safeValue(props.athletic_count)}</li>
      <li><strong>Average walk to transit:</strong> ${formatMinutes(props.mta_avgtm)}</li>
      <li><strong>Minimum walk to transit:</strong> ${formatMinutes(props.mta_mintm)}</li>
    </ul>
  `;

  document.getElementById("infoPanelWrap")?.classList.add("visible");
}

function refreshNeighborhoodStyle() {
  if (ntaLayer) {
    ntaLayer.setStyle(styleNeighborhood);
  }
}

function updateMetricNote() {
  const metric = metricSelect.value;

  if (metric === weightedModeField) {
    if (selectedProfile) {
      metricNote.textContent = `Showing weighted recommendation score for the ${profileWeights[selectedProfile].label} profile.`;
    } else {
      metricNote.textContent = "MoveSmart Score appears after choosing a lifestyle profile.";
    }
    return;
  }

  if (reversedMetrics.has(metric)) {
    metricNote.textContent = "Lower values are better for this metric. Stronger color means lower walk time.";
  } else {
    metricNote.textContent = "Higher values are shown with stronger color.";
  }
}

function updateLegend() {
  if (!ntaData) {
    legendContainer.innerHTML = "<div class='legend-row'>Loading...</div>";
    return;
  }

  const metric = metricSelect.value;
  const values = ntaData.features
    .map((f) => getNumericValue(f.properties, metric))
    .filter((v) => Number.isFinite(v));

  if (!values.length) {
    legendContainer.innerHTML = "<div class='legend-row'>No data</div>";
    return;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);

  const steps = 5;
  const isReversed = reversedMetrics.has(metric);

  const items = [];
  for (let i = 0; i < steps; i++) {
    const v = min + (max - min) * i / (steps - 1);
    const color = getColorForValue(v, metric, min, max);
    const label = formatLegendValue(v, metric);
    items.push({ color, label });
  }

  legendContainer.innerHTML = `
    <div class="legend-steps">
      ${items.map(({ color, label }) => `
        <div class="legend-step">
          <div class="legend-step-swatch" style="background:${color}"></div>
          <div class="legend-step-label">${label}</div>
        </div>
      `).join("")}
    </div>
  `;
}

function getNumericValue(props, field) {
  const value = props?.[field];
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function getColorForValue(value, metric, forcedMin = null, forcedMax = null) {
  if (value === null || value === undefined) {
    return "rgba(255,255,255,0.08)";
  }

  const values = ntaData.features
    .map((f) => getNumericValue(f.properties, metric))
    .filter((v) => Number.isFinite(v));

  const min = forcedMin ?? Math.min(...values);
  const max = forcedMax ?? Math.max(...values);

  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return "#56ccf2";
  }

  let t = (value - min) / (max - min);
  t = Math.max(0, Math.min(1, t));

  if (reversedMetrics.has(metric)) {
    t = 1 - t;
  }

  return interpolateColor("#1d2b53", "#56ccf2", "#bb6bd9", t);
}

function interpolateColor(c1, c2, c3, t) {
  if (t < 0.5) return blend(c1, c2, t * 2);
  return blend(c2, c3, (t - 0.5) * 2);
}

function blend(a, b, amount) {
  const ah = a.replace("#", "");
  const bh = b.replace("#", "");

  const ar = parseInt(ah.substring(0, 2), 16);
  const ag = parseInt(ah.substring(2, 4), 16);
  const ab = parseInt(ah.substring(4, 6), 16);

  const br = parseInt(bh.substring(0, 2), 16);
  const bg = parseInt(bh.substring(2, 4), 16);
  const bb = parseInt(bh.substring(4, 6), 16);

  const rr = Math.round(ar + (br - ar) * amount);
  const rg = Math.round(ag + (bg - ag) * amount);
  const rb = Math.round(ab + (bb - ab) * amount);

  return `rgb(${rr}, ${rg}, ${rb})`;
}

function pickFirstExisting(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
      return obj[key];
    }
  }
  return null;
}

function safeValue(value) {
  return value === null || value === undefined || value === "" ? "N/A" : value;
}

function formatMinutes(value) {
  const num = Number(value);
  return Number.isFinite(num) ? `${num.toFixed(1)} min` : "N/A";
}

function formatLegendValue(value, metric) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "N/A";
  if (metric === weightedModeField) return `${num.toFixed(0)}`;
  return reversedMetrics.has(metric) ? `${num.toFixed(1)} min` : `${num.toFixed(0)}`;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function updateCityStats() {
  if (!ntaData) return;

  const metric = metricSelect.value;
  const values = ntaData.features
    .map(f => getNumericValue(f.properties, metric))
    .filter(v => Number.isFinite(v));

  if (!values.length) return;

  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pct = max === min ? 50 : ((avg - min) / (max - min)) * 100;
  const aboveAvg = values.filter(v => v > avg).length;
  const metricLabel = metricSelect.options[metricSelect.selectedIndex]?.text || metric;

  document.getElementById("cityStatLabel").textContent = metricLabel;
  document.getElementById("cityStatValue").textContent = reversedMetrics.has(metric)
    ? formatMinutes(avg)
    : avg.toFixed(1);
  document.getElementById("cityStatAbove").textContent =
    `${aboveAvg} of ${values.length} neighborhoods above avg`;
  document.getElementById("cityStatMin").textContent = formatLegendValue(min, metric);
  document.getElementById("cityStatMax").textContent = formatLegendValue(max, metric);
  document.getElementById("cityStatMarker").style.left = `${pct.toFixed(1)}%`;
}

function initSearch() {
  const input = document.getElementById("neighborhoodSearch");
  const resultsEl = document.getElementById("searchResults");
  if (!input || !resultsEl) return;

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { resultsEl.style.display = "none"; resultsEl.innerHTML = ""; return; }

    const matches = [];
    ntaLayer.eachLayer((layer) => {
      const props = layer.feature.properties || {};
      const name = pickFirstExisting(props, ["ntaname", "NTAName", "NTA_NAME", "name", "Name"]) || "";
      if (name.toLowerCase().includes(q)) matches.push({ name, layer });
    });

    matches.sort((a, b) => a.name.localeCompare(b.name));
    const top = matches.slice(0, 7);

    if (!top.length) { resultsEl.style.display = "none"; return; }

    resultsEl.style.display = "block";
    resultsEl.innerHTML = top.map(({ name }, i) =>
      `<div class="search-result-item" data-idx="${i}">${escapeHtml(name)}</div>`
    ).join("");

    top.forEach(({ name, layer }, i) => {
      resultsEl.querySelector(`[data-idx="${i}"]`)?.addEventListener("click", () => {
        input.value = name;
        resultsEl.style.display = "none";
        map.fitBounds(layer.getBounds(), { padding: [60, 60] });
        layer.setStyle({ weight: 2.5, color: "#ffffff", fillOpacity: 0.9 });
        updateInfoPanel(layer.feature.properties);
      });
    });
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".hero-search")) resultsEl.style.display = "none";
  });
}

function initBoroughFilter() {
  document.querySelectorAll(".borough-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".borough-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeBorough = btn.dataset.boro;
      refreshNeighborhoodStyle();

      if (activeBorough === "all") {
        map.fitBounds(ntaLayer.getBounds(), { padding: [20, 20] });
      } else {
        const bounds = L.latLngBounds([]);
        ntaLayer.eachLayer((layer) => {
          if ((layer.feature.properties?.boroname || "") === activeBorough) {
            bounds.extend(layer.getBounds());
          }
        });
        if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] });
      }
    });
  });
}

function showTop5(profileKey) {
  const profileLabel = profileWeights[profileKey].label;

  const ranked = ntaData.features
    .map((f) => ({ props: f.properties, score: getNumericValue(f.properties, weightedModeField) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const itemsHtml = ranked.map(({ props, score }, i) => {
    const name = pickFirstExisting(props, ["ntaname", "NTAName", "NTA_NAME", "name", "Name"]) || "Neighborhood";
    return `
      <div class="top5-item" data-ntaname="${escapeHtml(String(props.ntaname || ""))}">
        <div class="top5-rank">${i + 1}</div>
        <div class="top5-name">${escapeHtml(String(name))}</div>
        <div class="top5-score">${score.toFixed(0)}</div>
      </div>`;
  }).join("");

  infoPanel.innerHTML = `
    <div class="top5-header">Top 5 for ${escapeHtml(profileLabel)}</div>
    <div class="top5-list">${itemsHtml}</div>
  `;

  document.getElementById("infoPanelWrap")?.classList.add("visible");

  ranked.forEach(({ props }) => {
    const el = infoPanel.querySelector(`[data-ntaname="${escapeHtml(String(props.ntaname || ""))}"]`);
    if (!el) return;
    el.addEventListener("click", () => {
      ntaLayer.eachLayer((layer) => {
        if ((layer.feature.properties?.ntaname || "") === (props.ntaname || "")) {
          map.fitBounds(layer.getBounds(), { padding: [60, 60] });
          layer.setStyle({ weight: 2.5, color: "#00ffa3", fillOpacity: 0.9 });
          updateInfoPanel(props);
        }
      });
    });
  });
}

function buildPopupRows(props, limit = 6) {
  return Object.entries(props || {})
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .slice(0, limit)
    .map(([key, value]) => {
      return `<div class="label">${escapeHtml(key)}</div><div>${escapeHtml(String(value))}</div>`;
    })
    .join("");
}