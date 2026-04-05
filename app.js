/* =========================================================
   app.js

   Responsibilities:
   - Load summary data from data/chart/chart_summary.json
   - Initialize Leaflet map for Colombia
   - Rebuild grid-cell polygons from embedded lat/lon arrays
   - Load annual grid overlays lazily from split grid files
   - Support Department / Colombia chart views
   - Draw bar + annual trend charts with uncertainty
   - Export chart data as CSV and the grid overlay as NetCDF
   ========================================================= */

const CHART_DATA_PATH = "data/chart/chart_summary.json";
const DEFAULT_SECTOR = "TotalAnth";
const DISPLAY_SECTORS = ["Coal", "Waste", "OilGas", "Livestock", "Reservoirs", "Rice", "Other", "TotalAnth"];
const BAR_DISPLAY_SECTORS = ["Coal", "Waste", "OilGas", "Livestock", "Reservoirs", "Rice", "Other"];

const DISPLAY_SECTOR_MAP = {
  Coal: ["Coal"],
  Waste: ["Landfills", "Wastewater"],
  OilGas: ["OilGas"],
  Livestock: ["Livestock"],
  Reservoirs: ["Reservoirs"],
  Rice: ["Rice"],
  Other: ["OtherAnth"],
  TotalAnth: ["TotalAnth"],
};

const SECTOR_LABELS = {
  Coal: "Coal",
  Waste: "Waste",
  OilGas: "Oil/Gas",
  Livestock: "Livestock",
  Reservoirs: "Reservoirs",
  Rice: "Rice",
  Other: "Other",
  TotalAnth: "Total anthropogenic",
};

const GRID_OPACITY = 0.65;
const GRID_COLORMAP = "ylorrd";
const GRID_DEFAULT_SLIDER_FRACTION = 0.6;
const GRID_MIN_VALUE = 0.001;
const PROVINCE_NAME_KEYS = ["PROVINCE", "province", "NAME_1", "name", "NAME"];
const GRID_UNITS_HTML = "kg km<sup>-2</sup> h<sup>-1</sup>";
const DEFAULT_PROVINCE_GEOJSON_PATH = "data/geo/province_geojson.json";

const state = {
  chartData: null,
  sectors: [],
  provinceNames: [],
  gridMeta: null,
  provinceGeojson: null,
  gridCache: {},

  map: null,
  provinceLayer: null,
  gridLayer: null,
  gridLegendControl: null,

  selectedProvince: null,
  currentGridCells: null,

  gridOpacity: GRID_OPACITY,
  gridDisplayMax: null,
  gridMinValue: GRID_MIN_VALUE,
  gridMaxValueRaw: null,

  unit: "Tg",
  unitFactor: 1,
  unitLabel: "",

  barChart: null,
  lineChart: null,

  el: {},
};

function $(id) {
  return document.getElementById(id);
}

function fmt(v) {
  if (v == null || !Number.isFinite(v)) return "";
  const abs = Math.abs(v);
  if (abs < 0.001) return v.toFixed(4);
  if (abs < 1) return v.toFixed(3);
  if (abs < 10) return v.toFixed(2);
  if (abs < 100) return v.toFixed(1);
  return Math.round(v).toString();
}

function fmtPlotValue(v, sigFigs = 2) {
  if (v == null || !Number.isFinite(v)) return "";
  if (v === 0) return "0";
  return Number(v).toPrecision(sigFigs).replace(/(\.\d*?[1-9])0+e/, "$1e").replace(/\.0+e/, "e").replace(/\.0+$/, "");
}

function labelSector(sectorKey) {
  return SECTOR_LABELS[sectorKey] ?? sectorKey;
}

function wrapSectorLabel(sectorKey) {
  const label = labelSector(sectorKey);
  if (label === "Oil/Gas") return ["Oil/Gas"];
  if (label === "Total anthropogenic") return ["Total", "anthropogenic"];
  return label.split(" ");
}

function formatUnitPeriod(period) {
  if (!period) return "";
  return String(period).replace("-1", "⁻¹");
}

function formatUnitLabel(mass, period) {
  return period ? `${mass} ${formatUnitPeriod(period)}` : mass;
}

function parseChartUnitSpec(spec) {
  if (!spec) return { mass: "Tg", period: "a-1", label: formatUnitLabel("Tg", "a-1") };
  const parts = String(spec).split(/\s+/);
  const mass = parts[0] ?? "";
  const period = parts[1] ?? "";
  return {
    mass,
    period,
    label: mass && period ? formatUnitLabel(mass, period) : String(spec),
  };
}

function getStoredUnitSpec() {
  return parseChartUnitSpec(state.chartData?.chart_units?.[getTimeMode()]);
}

function updateUnitSelectLabels() {
  const spec = getStoredUnitSpec();
  const tgOpt = state.el.unitSelect?.querySelector('option[value="Tg"]');
  const ggOpt = state.el.unitSelect?.querySelector('option[value="Gg"]');
  if (tgOpt) tgOpt.textContent = formatUnitLabel("Tg", spec.period);
  if (ggOpt) ggOpt.textContent = formatUnitLabel("Gg", spec.period);
}

function setUnits(newUnit) {
  const spec = getStoredUnitSpec();
  state.unit = newUnit;

  if (newUnit === spec.mass) {
    state.unitFactor = 1;
    state.unitLabel = formatUnitLabel(newUnit, spec.period);
  } else if (spec.mass === "Gg" && newUnit === "Tg") {
    state.unitFactor = 0.001;
    state.unitLabel = formatUnitLabel("Tg", spec.period);
  } else if (spec.mass === "Tg" && newUnit === "Gg") {
    state.unitFactor = 1000;
    state.unitLabel = formatUnitLabel("Gg", spec.period);
  } else {
    state.unitFactor = 1;
    state.unit = spec.mass;
    state.unitLabel = spec.label;
  }
}

function scaleVal(v) {
  return v == null || !Number.isFinite(v) ? null : v * state.unitFactor;
}

function getNiceLimits(minVal, maxVal) {
  if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
    return { min: undefined, max: undefined };
  }
  if (minVal === maxVal) {
    return { min: 0, max: maxVal * 1.1 + 1e-9 };
  }
  const pad = 0.06 * (maxVal - minVal);
  return { min: Math.max(0, minVal - pad), max: maxVal + pad };
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(rows) {
  return rows.map(row => row.map(csvEscape).join(",")).join("\n") + "\n";
}

function downloadText(filename, text, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function pad4(n) {
  return (4 - (n % 4)) % 4;
}

function stringFieldSize(str) {
  return 4 + str.length + pad4(str.length);
}

function charAttrSize(name, value) {
  const text = String(value);
  return stringFieldSize(name) + 4 + 4 + text.length + pad4(text.length);
}

function varSectionSize(name, dimIds, attrs) {
  let size = stringFieldSize(name);
  size += 4 + (dimIds.length * 4);
  size += 4 + 4;
  for (const attr of attrs) {
    size += charAttrSize(attr.name, attr.value);
  }
  size += 4 + 4 + 4;
  return size;
}

function writeString(view, offset, str) {
  view.setInt32(offset, str.length, false);
  offset += 4;
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
  offset += str.length;
  offset += pad4(str.length);
  return offset;
}

function writeCharAttr(view, offset, name, value) {
  const text = String(value);
  offset = writeString(view, offset, name);
  view.setInt32(offset, 2, false);
  offset += 4;
  view.setInt32(offset, text.length, false);
  offset += 4;
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
  offset += text.length;
  offset += pad4(text.length);
  return offset;
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function buildGridNetcdfBlob() {
  const grid = state.gridMeta;
  const timeKey = getSelectedTimeKey();
  const sectorKey = state.el.sectorSelect.value;
  const gridRecord = await ensureGridValuesLoaded(timeKey, sectorKey);
  const values = gridRecord?.values ?? null;

  if (!grid?.lats?.length || !grid?.lons?.length || !values?.length) {
    throw new Error("Grid data are not available for NetCDF export.");
  }

  const lats = grid.lats.map(Number);
  const lons = grid.lons.map(Number);
  const nlat = lats.length;
  const nlon = lons.length;
  const field = values.map(v => (Number.isFinite(v) ? Number(v) : Number.NaN));

  const dimSectionSize =
    4 + 4 +
    stringFieldSize("lat") + 4 +
    stringFieldSize("lon") + 4;
  const globalAttrSectionSize = 4 + 4;

  const vars = [
    {
      name: "lat",
      dimIds: [0],
      type: 6,
      dataBytes: nlat * 8,
      attrs: [
        { name: "long_name", value: "latitude" },
        { name: "units", value: "degrees_north" },
      ],
    },
    {
      name: "lon",
      dimIds: [1],
      type: 6,
      dataBytes: nlon * 8,
      attrs: [
        { name: "long_name", value: "longitude" },
        { name: "units", value: "degrees_east" },
      ],
    },
    {
      name: "emissions",
      dimIds: [0, 1],
      type: 5,
      dataBytes: nlat * nlon * 4,
      attrs: [
        { name: "long_name", value: `${labelSector(sectorKey)} emissions` },
        { name: "units", value: gridRecord?.units ?? state.chartData?.grid_units ?? "kg km-2 h-1" },
        { name: "time_key", value: timeKey },
        { name: "time_mode", value: getTimeMode() },
        { name: "sector", value: labelSector(sectorKey) },
      ],
    },
  ];

  const varListHeaderSize = 4 + 4;
  const varSectionTotal = vars.reduce((sum, variable) => (
    sum + varSectionSize(variable.name, variable.dimIds, variable.attrs)
  ), 0);

  const headerSize = 4 + 4 + dimSectionSize + globalAttrSectionSize + varListHeaderSize + varSectionTotal;

  let dataOffset = headerSize;
  for (const variable of vars) {
    variable.begin = dataOffset;
    dataOffset += variable.dataBytes;
  }

  const buffer = new ArrayBuffer(dataOffset);
  const view = new DataView(buffer);
  let offset = 0;

  view.setUint8(offset++, "C".charCodeAt(0));
  view.setUint8(offset++, "D".charCodeAt(0));
  view.setUint8(offset++, "F".charCodeAt(0));
  view.setUint8(offset++, 1);

  view.setInt32(offset, 0, false);
  offset += 4;

  view.setInt32(offset, 10, false);
  offset += 4;
  view.setInt32(offset, 2, false);
  offset += 4;

  offset = writeString(view, offset, "lat");
  view.setInt32(offset, nlat, false);
  offset += 4;

  offset = writeString(view, offset, "lon");
  view.setInt32(offset, nlon, false);
  offset += 4;

  view.setInt32(offset, 0, false);
  offset += 4;
  view.setInt32(offset, 0, false);
  offset += 4;

  view.setInt32(offset, 11, false);
  offset += 4;
  view.setInt32(offset, vars.length, false);
  offset += 4;

  for (const variable of vars) {
    offset = writeString(view, offset, variable.name);
    view.setInt32(offset, variable.dimIds.length, false);
    offset += 4;
    variable.dimIds.forEach(dimId => {
      view.setInt32(offset, dimId, false);
      offset += 4;
    });

    view.setInt32(offset, 12, false);
    offset += 4;
    view.setInt32(offset, variable.attrs.length, false);
    offset += 4;
    variable.attrs.forEach(attr => {
      offset = writeCharAttr(view, offset, attr.name, attr.value);
    });

    view.setInt32(offset, variable.type, false);
    offset += 4;
    view.setInt32(offset, variable.dataBytes, false);
    offset += 4;
    view.setInt32(offset, variable.begin, false);
    offset += 4;
  }

  let dataPos = vars[0].begin;
  lats.forEach(value => {
    view.setFloat64(dataPos, value, false);
    dataPos += 8;
  });

  dataPos = vars[1].begin;
  lons.forEach(value => {
    view.setFloat64(dataPos, value, false);
    dataPos += 8;
  });

  dataPos = vars[2].begin;
  field.forEach(value => {
    view.setFloat32(dataPos, value, false);
    dataPos += 4;
  });

  return new Blob([buffer], { type: "application/x-netcdf" });
}

function getViewMode() {
  const el = document.querySelector('input[name="viewMode"]:checked');
  return el ? el.value : "colombia";
}

function getTimeMode() {
  return "annual";
}

function getSeriesStore() {
  return state.chartData.annual;
}

function getTimeKeys() {
  const store = getSeriesStore();
  return store.years ?? [];
}

function getSelectedTimeKey() {
  return state.el.timeSelect?.value ?? "";
}

function formatPlaceName(name) {
  if (!name) return name;
  return String(name)
    .toLowerCase()
    .replace(/\b([a-z])/g, match => match.toUpperCase());
}

function normalizePlaceKey(name) {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toUpperCase();
}

function resolveProvinceKey(name) {
  if (!name) return null;
  const provinces = state.chartData?.annual?.provinces ?? {};
  if (name in provinces) return name;

  const normalizedTarget = normalizePlaceKey(name);
  for (const key of Object.keys(provinces)) {
    if (normalizePlaceKey(key) === normalizedTarget) return key;
  }
  return null;
}

function getCurrentPlaceLabel() {
  const viewMode = getViewMode();
  if (viewMode === "colombia") return "Colombia";
  if (viewMode === "province") return state.selectedProvince ? formatPlaceName(state.selectedProvince) : "(none)";
  return "(none)";
}

function currentSelectionIsValid() {
  const viewMode = getViewMode();
  if (viewMode === "colombia") return true;
  if (viewMode === "province") return !!state.selectedProvince;
  return false;
}

function getProvinceName(feature) {
  const props = feature?.properties ?? {};
  for (const key of PROVINCE_NAME_KEYS) {
    if (props[key] != null && String(props[key]).trim()) return String(props[key]).trim();
  }
  return null;
}

function syncSelectedLabel() {
  if (state.el.selectedRegion) {
    state.el.selectedRegion.textContent = getCurrentPlaceLabel();
  }
}

function syncActiveMapLayer() {
  state.gridLayer?.bringToBack();
  state.provinceLayer?.bringToFront();
}

function setDataHint() {
  if (!state.el.dataHint) return;
  const viewMode = getViewMode();

  let msg = "Charts are loaded from chart_summary.json, and the map loads annual grid files on demand.";
  msg += " The bar chart summarizes the selected year, and the trend chart shows annual change through time.";
  msg += viewMode === "province"
    ? " Click a department boundary to update the charts."
    : " Colombia-wide totals are shown while the gridded emissions field remains visible.";

  state.el.dataHint.textContent = msg;
}

function makeValueRange(obj) {
  if (!obj || typeof obj !== "object") {
    return { value: null, min: null, max: null };
  }
  return {
    value: Number.isFinite(obj.value) ? obj.value : null,
    min: Number.isFinite(obj.min) ? obj.min : null,
    max: Number.isFinite(obj.max) ? obj.max : null,
  };
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}`);
  return res.json();
}

async function ensureChartDataLoaded() {
  if (state.chartData) return;

  state.chartData = await fetchJSON(CHART_DATA_PATH);
  state.sectors = state.chartData.display_sectors ?? [];
  state.gridMeta = state.chartData.grid ?? null;
  const provincePath = state.chartData.province_geojson_path || DEFAULT_PROVINCE_GEOJSON_PATH;
  state.provinceGeojson = state.chartData.province_geojson ?? await fetchJSON(provincePath);
  state.provinceNames = Object.keys(state.chartData.annual?.provinces ?? {}).sort();
}

function getGridFilePath(timeKey, sectorKey) {
  return state.chartData?.grid_files?.annual?.[timeKey]?.[sectorKey] ?? null;
}

async function ensureGridValuesLoaded(timeKey, sectorKey) {
  if (!timeKey || !sectorKey) return null;

  if (!state.gridCache[timeKey]) {
    state.gridCache[timeKey] = {};
  }

  if (state.gridCache[timeKey][sectorKey]) {
    return state.gridCache[timeKey][sectorKey];
  }

  const path = getGridFilePath(timeKey, sectorKey);
  if (!path) return null;

  const payload = await fetchJSON(path);
  const values = Array.isArray(payload?.values)
    ? payload.values.map(v => (Number.isFinite(v) ? Number(v) : null))
    : null;

  const record = {
    path,
    units: payload?.units ?? state.chartData?.grid_units ?? "kg km-2 h-1",
    values,
  };

  state.gridCache[timeKey][sectorKey] = record;
  return record;
}

function getGridUnitsHtml() {
  const units = state.chartData?.grid_units;
  return units === "kg km-2 h-1" ? GRID_UNITS_HTML : (units ?? GRID_UNITS_HTML);
}

function getGridBounds() {
  const grid = state.gridMeta;
  if (!grid?.lats?.length || !grid?.lons?.length) {
    return L.latLngBounds([[-6.5, -80.8], [14.8, -66.5]]);
  }

  const lats = grid.lats;
  const lons = grid.lons;
  const dlat = lats.length > 1 ? Math.abs(lats[1] - lats[0]) : 0.25;
  const dlon = lons.length > 1 ? Math.abs(lons[1] - lons[0]) : 0.25;

  const south = Math.min(...lats) - dlat / 2;
  const north = Math.max(...lats) + dlat / 2;
  const west = Math.min(...lons) - dlon / 2;
  const east = Math.max(...lons) + dlon / 2;
  return L.latLngBounds([[south, west], [north, east]]);
}

function getSelectionEntry(timeKey) {
  const store = getSeriesStore();
  const viewMode = getViewMode();

  if (viewMode === "colombia") {
    return store.colombia?.[timeKey] ?? null;
  }
  if (viewMode === "province") {
    const provinceKey = resolveProvinceKey(state.selectedProvince);
    return provinceKey ? store.provinces?.[provinceKey]?.[timeKey] ?? null : null;
  }
  return null;
}

function aggregateRange(entry, displaySectorKey) {
  if (!entry) return { value: null, min: null, max: null };

  if (entry[displaySectorKey]) {
    return makeValueRange(entry[displaySectorKey]);
  }

  const sectorKeys = DISPLAY_SECTOR_MAP[displaySectorKey] ?? [displaySectorKey];
  let value = 0;
  let min = 0;
  let max = 0;
  let hasValue = false;
  let hasMin = false;
  let hasMax = false;

  for (const key of sectorKeys) {
    const vr = makeValueRange(entry[key]);
    if (Number.isFinite(vr.value)) {
      value += vr.value;
      hasValue = true;
    }
    if (Number.isFinite(vr.min)) {
      min += vr.min;
      hasMin = true;
    }
    if (Number.isFinite(vr.max)) {
      max += vr.max;
      hasMax = true;
    }
  }

  return {
    value: hasValue ? value : null,
    min: hasMin ? min : null,
    max: hasMax ? max : null,
  };
}

function getGridOpacity() {
  const v = Number(state.el.gridOpacitySlider?.value);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v / 100)) : GRID_OPACITY;
}

function syncGridOpacityUI() {
  if (state.el.gridOpacityValue) {
    state.el.gridOpacityValue.textContent = `${Math.round(getGridOpacity() * 100)}%`;
  }
}

function applyGridOpacity() {
  state.gridOpacity = getGridOpacity();
  syncGridOpacityUI();
  if (state.gridLayer) {
    state.gridLayer.setStyle(feature => gridFeatureStyle(feature));
  }
}

function currentGridMax() {
  return Number.isFinite(state.gridDisplayMax) ? state.gridDisplayMax : state.gridMaxValueRaw;
}

function syncGridSlider() {
  const slider = state.el.gridMaxSlider;
  const out = state.el.gridMaxValue;
  if (!slider || !out) return;

  if (!Number.isFinite(state.gridMaxValueRaw) || state.gridMaxValueRaw <= 0) {
    slider.disabled = true;
    out.innerHTML = "";
    return;
  }

  slider.disabled = false;

  if (!Number.isFinite(state.gridDisplayMax)) {
    state.gridDisplayMax = state.gridMaxValueRaw;
  }

  state.gridDisplayMax = Math.max(state.gridMinValue, Math.min(state.gridMaxValueRaw, state.gridDisplayMax));
  const denom = (state.gridMaxValueRaw - state.gridMinValue) || 1;
  const t = (state.gridDisplayMax - state.gridMinValue) / denom;
  slider.value = String(Math.round(Math.max(0, Math.min(1, t)) * 1000));
  out.innerHTML = `${fmt(state.gridDisplayMax)} ${getGridUnitsHtml()}`;
}

function handleGridSliderInput() {
  if (!Number.isFinite(state.gridMaxValueRaw)) return;
  const rawT = Number(state.el.gridMaxSlider.value) / 1000;
  const denom = (state.gridMaxValueRaw - state.gridMinValue) || 1;
  state.gridDisplayMax = state.gridMinValue + rawT * denom;

  if (state.el.gridMaxValue) {
    state.el.gridMaxValue.innerHTML = `${fmt(state.gridDisplayMax)} ${getGridUnitsHtml()}`;
  }

  if (state.gridLayer) state.gridLayer.setStyle(feature => gridFeatureStyle(feature));
  updateGridLegend();
}

function updateGridLegend() {
  const ctl = state.gridLegendControl;
  if (!ctl?._container) return;
  if (!state.gridLayer) {
    ctl._container.innerHTML = "";
    return;
  }

  const min = Number.isFinite(state.gridMinValue) ? state.gridMinValue : 0;
  const max = currentGridMax();
  if (!Number.isFinite(max)) {
    ctl._container.innerHTML = "";
    return;
  }

  const colors = [];
  for (let i = 0; i < 40; i++) {
    colors.push(chroma.scale(GRID_COLORMAP)(i / 39).hex());
  }
  const gradient = `linear-gradient(to right, ${colors.join(",")})`;
  const sectorKey = state.el.sectorSelect?.value ?? DEFAULT_SECTOR;

  ctl._container.innerHTML = `
    <div class="legend">
      <div class="title">${labelSector(sectorKey)}</div>
      <div class="units">${getGridUnitsHtml()}</div>
      <div class="bar" style="background:${gradient};"></div>
      <div class="labels">
        <span>${fmt(min)}</span>
        <span>${fmt(max)}</span>
      </div>
    </div>
  `;
}

function buildGridCells() {
  const grid = state.gridMeta;
  if (!grid?.lats?.length || !grid?.lons?.length) {
    throw new Error("Missing grid metadata in chart_summary.json");
  }

  const lats = grid.lats;
  const lons = grid.lons;
  const nlat = lats.length;
  const nlon = lons.length;

  const dlat = nlat > 1 ? Math.abs(lats[1] - lats[0]) : 0.25;
  const dlon = nlon > 1 ? Math.abs(lons[1] - lons[0]) : 0.25;

  const cells = [];
  for (let i = 0; i < nlat; i++) {
    for (let j = 0; j < nlon; j++) {
      const lat = Number(lats[i]);
      const lon = Number(lons[j]);
      const lat0 = lat - dlat / 2;
      const lat1 = lat + dlat / 2;
      const lon0 = lon - dlon / 2;
      const lon1 = lon + dlon / 2;

      cells.push({
        type: "Feature",
        properties: {
          lat_idx: i,
          lon_idx: j,
          flatIndex: i * nlon + j,
          lat,
          lon,
          value: null,
        },
        geometry: {
          type: "Polygon",
          coordinates: [[
            [lon0, lat0],
            [lon1, lat0],
            [lon1, lat1],
            [lon0, lat1],
            [lon0, lat0],
          ]],
        },
      });
    }
  }
  return cells;
}

function getFeatureMapValue(feature) {
  const n = Number(feature?.properties?.value);
  return Number.isFinite(n) ? n : null;
}

function gridFeatureStyle(feature) {
  const value = getFeatureMapValue(feature);
  const max = currentGridMax();
  const min = Number.isFinite(state.gridMinValue) ? state.gridMinValue : 0;
  let fillColor = "#00000000";

  if (value != null && Number.isFinite(max) && max > min) {
    const t = Math.max(0, Math.min(1, (value - min) / ((max - min) || 1)));
    fillColor = chroma.scale(GRID_COLORMAP)(t).hex();
  }

  return {
    color: "rgba(82, 107, 145, 0.30)",
    weight: 0.18,
    fillColor,
    fillOpacity: value == null ? 0 : getGridOpacity(),
  };
}

function provinceFeatureStyle(feature) {
  const name = getProvinceName(feature);
  const isSelected = getViewMode() === "province"
    && normalizePlaceKey(name) === normalizePlaceKey(state.selectedProvince);
  const isProvinceMode = getViewMode() === "province";

  return {
    color: isSelected ? "#1341a3" : "#486487",
    weight: isSelected ? 2.2 : (isProvinceMode ? 1.3 : 1),
    fillColor: isSelected ? "#4e83ff" : "#b3cbff",
    fillOpacity: isSelected ? 0.16 : (isProvinceMode ? 0.05 : 0),
  };
}

function clearGridLayer() {
  if (state.gridLayer && state.map?.hasLayer(state.gridLayer)) {
    state.map.removeLayer(state.gridLayer);
  }
  state.gridLayer = null;
  state.gridMinValue = GRID_MIN_VALUE;
  state.gridMaxValueRaw = null;
  state.gridDisplayMax = null;
  updateGridLegend();
  syncGridSlider();
}

async function updateMapOverlay() {
  const timeKey = getSelectedTimeKey();
  const sectorKey = state.el.sectorSelect.value;

  if (!timeKey || !sectorKey) {
    clearGridLayer();
    return;
  }

  const gridRecord = await ensureGridValuesLoaded(timeKey, sectorKey);
  const values = gridRecord?.values ?? null;
  if (!values?.length) {
    clearGridLayer();
    return;
  }

  if (state.gridLayer && state.map?.hasLayer(state.gridLayer)) {
    state.map.removeLayer(state.gridLayer);
  }

  const cells = state.currentGridCells.map(feature => {
    const value = values[feature.properties.flatIndex];
    return {
      ...feature,
      properties: {
        ...feature.properties,
        value: Number.isFinite(value) ? value : null,
      },
    };
  });

  const finiteValues = values.filter(Number.isFinite);
  state.gridMinValue = GRID_MIN_VALUE;
  state.gridMaxValueRaw = finiteValues.length ? Math.max(...finiteValues) : null;
  state.gridDisplayMax = Number.isFinite(state.gridMaxValueRaw) && state.gridMaxValueRaw > state.gridMinValue
    ? state.gridMinValue + GRID_DEFAULT_SLIDER_FRACTION * (state.gridMaxValueRaw - state.gridMinValue)
    : state.gridMaxValueRaw;
  syncGridSlider();

  state.gridLayer = L.geoJSON({ type: "FeatureCollection", features: cells }, {
    pane: "gridPane",
    interactive: false,
    style: feature => gridFeatureStyle(feature),
  }).addTo(state.map);

  syncActiveMapLayer();
  updateGridLegend();
}

async function initMap() {
  const gridBounds = getGridBounds();

  state.map = L.map("map", {
    maxBounds: gridBounds,
    maxBoundsViscosity: 1,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
  });

  state.map.createPane("gridPane");
  state.map.createPane("provincePane");
  state.map.getPane("gridPane").style.zIndex = "410";
  state.map.getPane("provincePane").style.zIndex = "420";

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 12,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(state.map);

  state.currentGridCells = buildGridCells();

  state.provinceLayer = L.geoJSON(state.provinceGeojson, {
    pane: "provincePane",
    style: feature => provinceFeatureStyle(feature),
    onEachFeature: (feature, layer) => {
      layer.on("click", async () => {
        if (getViewMode() !== "province") return;
        const name = getProvinceName(feature);
        if (!name) return;
        state.selectedProvince = resolveProvinceKey(name) ?? name;
        syncSelectedLabel();
        if (state.provinceLayer) state.provinceLayer.setStyle(f => provinceFeatureStyle(f));
        await updateCharts();
      });
    },
  }).addTo(state.map);

  state.gridLegendControl = L.control({ position: "bottomright" });
  state.gridLegendControl.onAdd = function () {
    const div = L.DomUtil.create("div");
    div.className = "legend";
    div.innerHTML = "";
    return div;
  };
  state.gridLegendControl.addTo(state.map);
  L.DomEvent.disableClickPropagation(state.gridLegendControl.getContainer());
  syncActiveMapLayer();
  const fitPadding = L.point(8, 8);
  state.map.fitBounds(gridBounds, { padding: fitPadding });
  state.map.setMinZoom(state.map.getBoundsZoom(gridBounds, false, fitPadding));
  state.map.setZoom(state.map.getZoom() + 0.5);
}

const barErrorBarsPlugin = {
  id: "barErrorBars",
  afterDatasetsDraw(chart) {
    const meta = chart.getDatasetMeta(0);
    if (!meta?.data?.length) return;
    const ds = chart.data.datasets[0];
    const mins = ds._errMin || [];
    const maxs = ds._errMax || [];
    if (!mins.length || !maxs.length) return;

    const { ctx } = chart;
    ctx.save();
    ctx.lineWidth = 1;

    meta.data.forEach((barElem, i) => {
      const yMin = mins[i];
      const yMax = maxs[i];
      if (yMin == null || yMax == null || Number.isNaN(yMin) || Number.isNaN(yMax)) return;
      const x = barElem.x;
      const yTop = chart.scales.y.getPixelForValue(yMax);
      const yBot = chart.scales.y.getPixelForValue(yMin);
      const cap = 8;

      ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - cap, yTop); ctx.lineTo(x + cap, yTop); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - cap, yBot); ctx.lineTo(x + cap, yBot); ctx.stroke();
    });

    ctx.restore();
  },
};

function initCharts() {
  state.barChart = new Chart(state.el.barChart, {
    type: "bar",
    data: {
      labels: [],
      datasets: [{ label: "Emissions", data: [], _errMin: [], _errMax: [] }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: {
          display: true,
          text: "Select a place",
          font: { size: 14, weight: "700" },
          padding: { bottom: 14 },
        },
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(context) {
              return ` ${fmtPlotValue(context.parsed.y)} ${state.unitLabel}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            minRotation: 0,
            maxRotation: 0,
            autoSkip: false,
            font: { size: 11 },
            padding: 10,
          },
        },
        y: {
          beginAtZero: true,
          ticks: {
            font: { size: 11 },
            padding: 6,
            callback: value => fmtPlotValue(value),
          },
          title: {
            display: true,
            text: `Emissions (${state.unitLabel})`,
            font: { size: 12, weight: "600" },
            padding: { bottom: 8 },
          },
        },
      },
    },
    plugins: [barErrorBarsPlugin],
  });
  state.barChart.data.datasets[0].backgroundColor = "rgba(58, 123, 213, 0.72)";
  state.barChart.data.datasets[0].borderColor = "rgba(23, 74, 153, 0.95)";
  state.barChart.data.datasets[0].borderWidth = 1;

  state.lineChart = new Chart(state.el.lineChart, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        { label: "min", data: [], pointRadius: 0, borderWidth: 0 },
        { label: "max", data: [], pointRadius: 0, borderWidth: 0, fill: "-1", backgroundColor: "rgba(85, 140, 233, 0.16)" },
        { label: "Value", data: [], tension: 0.2, pointRadius: 2, borderColor: "#1a56c8", backgroundColor: "#1a56c8" },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: {
          display: true,
          text: "",
          font: { size: 14, weight: "700" },
          padding: { bottom: 14 },
        },
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(context) {
              const label = context.dataset.label === "Value" ? "Value" : context.dataset.label;
              return ` ${label}: ${fmtPlotValue(context.parsed.y)} ${state.unitLabel}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            font: { size: 11 },
            maxRotation: 0,
            padding: 8,
          },
        },
        y: {
          beginAtZero: true,
          ticks: {
            font: { size: 11 },
            padding: 6,
            callback: value => fmtPlotValue(value),
          },
          title: {
            display: true,
            text: `Emissions (${state.unitLabel})`,
            font: { size: 12, weight: "600" },
            padding: { bottom: 8 },
          },
        },
      },
    },
  });
}

async function buildBarData() {
  const timeKey = getSelectedTimeKey();
  const entry = getSelectionEntry(timeKey);

  if (!entry) return { labels: [], values: [], mins: [], maxs: [] };

  const rows = BAR_DISPLAY_SECTORS.map(label => {
    const range = aggregateRange(entry, label);
    return {
      label,
      value: scaleVal(range.value),
      min: scaleVal(range.min),
      max: scaleVal(range.max),
    };
  });

  rows.sort((a, b) => {
    const aVal = Number.isFinite(a.value) ? a.value : Number.NEGATIVE_INFINITY;
    const bVal = Number.isFinite(b.value) ? b.value : Number.NEGATIVE_INFINITY;
    return bVal - aVal;
  });

  return {
    labels: rows.map(row => row.label),
    values: rows.map(row => row.value),
    mins: rows.map(row => row.min),
    maxs: rows.map(row => row.max),
  };
}

async function buildLineData() {
  const sectorKey = state.el.sectorSelect.value;
  const timeKeys = getTimeKeys();
  const labels = [...timeKeys];
  const values = [];
  const mins = [];
  const maxs = [];

  for (const timeKey of timeKeys) {
    const entry = getSelectionEntry(timeKey);
    const vr = aggregateRange(entry, sectorKey);
    values.push(scaleVal(vr.value));
    mins.push(scaleVal(vr.min));
    maxs.push(scaleVal(vr.max));
  }

  return { labels, values, mins, maxs };
}

function clearCharts() {
  if (!state.barChart || !state.lineChart) return;
  state.barChart.data.labels = [];
  state.barChart.data.datasets[0].data = [];
  state.barChart.data.datasets[0]._errMin = [];
  state.barChart.data.datasets[0]._errMax = [];
  state.barChart.options.plugins.title.text = "Select a place";
  state.barChart.update();

  state.lineChart.data.labels = [];
  state.lineChart.data.datasets[0].data = [];
  state.lineChart.data.datasets[1].data = [];
  state.lineChart.data.datasets[2].data = [];
  state.lineChart.options.plugins.title.text = "";
  state.lineChart.update();
}

async function updateCharts() {
  syncSelectedLabel();
  setDataHint();
  if (!state.barChart || !state.lineChart) return;
  if (!currentSelectionIsValid()) return clearCharts();

  const timeKey = getSelectedTimeKey();
  const sectorKey = state.el.sectorSelect.value;
  const place = getCurrentPlaceLabel();
  const timeMode = getTimeMode();

  const bar = await buildBarData();
  state.barChart.data.labels = bar.labels.map(wrapSectorLabel);
  state.barChart.data.datasets[0].data = bar.values;
  state.barChart.data.datasets[0]._errMin = bar.mins;
  state.barChart.data.datasets[0]._errMax = bar.maxs;

  const finiteVals = bar.values.filter(Number.isFinite);
  const finiteMins = bar.mins.filter(Number.isFinite);
  const finiteMaxs = bar.maxs.filter(Number.isFinite);
  const overallMin = finiteMins.length ? Math.min(...finiteMins) : 0;
  const overallMax = finiteMaxs.length ? Math.max(...finiteMaxs) : (finiteVals.length ? Math.max(...finiteVals) : 1);
  const barLimits = getNiceLimits(overallMin, overallMax);
  state.barChart.options.scales.y.min = barLimits.min;
  state.barChart.options.scales.y.max = barLimits.max;
  state.barChart.options.scales.y.title.text = `Emissions (${state.unitLabel})`;
  state.barChart.options.plugins.title.text = `${place} - ${timeKey}`;
  state.barChart.update();

  const line = await buildLineData();
  state.lineChart.data.labels = line.labels;
  state.lineChart.data.datasets[0].data = line.mins;
  state.lineChart.data.datasets[1].data = line.maxs;
  state.lineChart.data.datasets[2].data = line.values;

  const finiteMins2 = line.mins.filter(Number.isFinite);
  const finiteMaxs2 = line.maxs.filter(Number.isFinite);
  const finiteVals2 = line.values.filter(Number.isFinite);
  const lineMin = finiteMins2.length ? Math.min(...finiteMins2) : (finiteVals2.length ? Math.min(...finiteVals2) : 0);
  const lineMax = finiteMaxs2.length ? Math.max(...finiteMaxs2) : (finiteVals2.length ? Math.max(...finiteVals2) : 1);
  const lineLimits = getNiceLimits(lineMin, lineMax);
  state.lineChart.options.scales.y.min = lineLimits.min;
  state.lineChart.options.scales.y.max = lineLimits.max;
  state.lineChart.options.scales.y.title.text = `Emissions (${state.unitLabel})`;
  state.lineChart.options.plugins.title.text = `${place} - ${labelSector(sectorKey)} (${timeMode === "annual" ? "annual trend" : timeMode})`;
  state.lineChart.update();
}

async function makeBarCsvRows() {
  const bar = await buildBarData();
  return [
    ["type", "bar"],
    ["view_mode", getViewMode()],
    ["time_mode", getTimeMode()],
    ["place", getCurrentPlaceLabel()],
    ["time_key", getSelectedTimeKey()],
    ["units", state.unitLabel],
    [],
    ["sector", "value", "min", "max"],
    ...bar.labels.map((label, i) => [labelSector(label), bar.values[i], bar.mins[i], bar.maxs[i]]),
  ];
}

async function makeLineCsvRows() {
  const line = await buildLineData();
  return [
    ["type", "annual_trend"],
    ["view_mode", getViewMode()],
    ["time_mode", getTimeMode()],
    ["place", getCurrentPlaceLabel()],
    ["selected_time_key", getSelectedTimeKey()],
    ["sector", labelSector(state.el.sectorSelect.value)],
    ["units", state.unitLabel],
    [],
    ["year", "value", "min", "max"],
    ...line.labels.map((label, i) => [label, line.values[i], line.mins[i], line.maxs[i]]),
  ];
}

function populateSelect(selectEl, items, defaultValue, formatter = value => value) {
  selectEl.innerHTML = "";
  for (const item of items) {
    const opt = document.createElement("option");
    opt.value = item;
    opt.textContent = formatter(item);
    selectEl.appendChild(opt);
  }
  selectEl.value = defaultValue && items.includes(defaultValue) ? defaultValue : (items[0] ?? "");
}

function initSelects() {
  const prevTime = state.el.timeSelect?.value ?? "";
  const prevSector = state.el.sectorSelect?.value ?? "";

  const timeKeys = getTimeKeys();
  const defaultTime = timeKeys[timeKeys.length - 1] ?? "";

  populateSelect(state.el.timeSelect, timeKeys, prevTime || defaultTime);
  const sectors = DISPLAY_SECTORS;
  const defaultSector = sectors.includes(DEFAULT_SECTOR) ? DEFAULT_SECTOR : sectors[0];
  populateSelect(state.el.sectorSelect, sectors, prevSector || defaultSector, labelSector);
}

async function handleViewModeChange() {
  if (getViewMode() === "colombia") {
    state.selectedProvince = null;
  }
  syncSelectedLabel();
  if (state.provinceLayer) state.provinceLayer.setStyle(f => provinceFeatureStyle(f));
  syncActiveMapLayer();
  await updateCharts();
}

async function handleTimeModeChange() {
  initSelects();
  updateUnitSelectLabels();
  setUnits(state.unit);
  await updateMapOverlay();
  await updateCharts();
}

function wireEvents() {
  document.querySelectorAll('input[name="viewMode"]').forEach(el => {
    el.addEventListener("change", async () => {
      await handleViewModeChange();
    });
  });

  state.el.timeSelect?.addEventListener("change", async () => {
    await updateMapOverlay();
    await updateCharts();
  });

  state.el.sectorSelect?.addEventListener("change", async () => {
    await updateMapOverlay();
    await updateCharts();
  });

  state.el.unitSelect?.addEventListener("change", async () => {
    setUnits(state.el.unitSelect.value);
    await updateCharts();
  });

  state.el.gridOpacitySlider?.addEventListener("input", () => {
    applyGridOpacity();
  });

  state.el.gridMaxSlider?.addEventListener("input", () => {
    handleGridSliderInput();
  });

  state.el.downloadBarCsv?.addEventListener("click", async () => {
    if (!currentSelectionIsValid()) return;
    const filename = `bar_${getViewMode()}_${getCurrentPlaceLabel()}_${getSelectedTimeKey()}_${state.unit}.csv`
      .replace(/\s+/g, "_");
    downloadText(filename, toCSV(await makeBarCsvRows()));
  });

  state.el.downloadLineCsv?.addEventListener("click", async () => {
    if (!currentSelectionIsValid()) return;
    const sectorKey = state.el.sectorSelect.value;
    const filename = `annual_trend_${getViewMode()}_${getCurrentPlaceLabel()}_${labelSector(sectorKey)}_${state.unit}.csv`
      .replace(/\s+/g, "_");
    downloadText(filename, toCSV(await makeLineCsvRows()));
  });

  state.el.downloadGridNetcdf?.addEventListener("click", async () => {
    const sectorKey = state.el.sectorSelect.value;
    const filename = `grid_${getSelectedTimeKey()}_${labelSector(sectorKey)}.nc`
      .replace(/\s+/g, "_");
    downloadBlob(filename, await buildGridNetcdfBlob());
  });
}

function handleResponsiveResize() {
  state.map?.invalidateSize();
  state.barChart?.resize();
  state.lineChart?.resize();
}

async function main() {
  state.el = {
    timeSelect: $("timeSelect"),
    sectorSelect: $("sectorSelect"),
    unitSelect: $("unitSelect"),
    gridOpacitySlider: $("gridOpacitySlider"),
    gridOpacityValue: $("gridOpacityValue"),
    gridMaxSlider: $("gridMaxSlider"),
    gridMaxValue: $("gridMaxValue"),
    selectedRegion: $("selectedRegion"),
    downloadBarCsv: $("downloadBarCsv"),
    downloadLineCsv: $("downloadLineCsv"),
    downloadGridNetcdf: $("downloadGridNetcdf"),
    barChart: $("barChart"),
    lineChart: $("lineChart"),
    dataHint: $("dataHint"),
  };

  await ensureChartDataLoaded();
  updateUnitSelectLabels();
  setUnits(state.el.unitSelect.value);
  initSelects();
  await initMap();
  initCharts();
  syncGridOpacityUI();
  syncSelectedLabel();
  setDataHint();

  window.addEventListener("resize", () => {
    clearTimeout(window.__resizeTimer);
    window.__resizeTimer = setTimeout(handleResponsiveResize, 150);
  });

  await updateMapOverlay();
  await updateCharts();
  wireEvents();
}

main().catch(err => {
  console.error("Application failed to start:", err);
});
