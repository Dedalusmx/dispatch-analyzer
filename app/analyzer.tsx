"use client";
import { useState, useCallback, useMemo, useEffect } from "react";

// ═══════════════════════════════════════════════════════════════════
// CALCULATION ENGINE — Preserved from audited V1.1 (132 tests)
// Includes: HOS planning, risk analysis, decision score,
//           negotiation strategy, daily mileage, reload risk
// ═══════════════════════════════════════════════════════════════════

function calculateTotalMiles(dh, ld) { return (dh || 0) + (ld || 0); }
function calculateLoadedRPM(r, m) { return (!m || m <= 0 || !r || r < 0) ? 0 : r / m; }
function calculateAllMilesRPM(r, m) { return (!m || m <= 0 || !r || r < 0) ? 0 : r / m; }
function calculateDeadheadPercentage(dh, tm) { return (!tm || tm <= 0) ? 0 : ((dh || 0) / tm) * 100; }
function calculateEstimatedDrivingTime(m, s) { return (!m || m <= 0 || !s || s <= 0) ? 0 : m / s; }
function calculateDeliveryBuffer(eta, del) { return (!eta || !del) ? null : (del.getTime() - eta.getTime()) / 60000; }

function parseTimeToHours(s) {
  if (!s) return 0;
  const p = s.split(":");
  return (parseFloat(p[0]) || 0) + (parseFloat(p[1]) || 0) / 60;
}

function parseDateTimeInputs(d, t) {
  if (!d) return null;
  const ti = t || "08:00";
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = ti.split(":").map(Number);
  return new Date(y, mo - 1, da, h || 0, mi || 0);
}

function formatCurrency(v) {
  if (v == null || isNaN(v)) return "$0";
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function formatCurrencyDecimal(v) {
  return (v == null || isNaN(v)) ? "$0.00" : "$" + v.toFixed(2);
}
function formatMinutes(m) {
  if (m == null || isNaN(m)) return "—";
  const neg = m < 0, a = Math.abs(m), h = Math.floor(a / 60), mi = Math.round(a % 60);
  return (neg ? "-" : "") + (h > 0 ? `${h}h ` : "") + `${mi}m`;
}
function formatTime(d) {
  return d ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }) : "—";
}
function formatDateTime(d) {
  return d ? d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) + " " + formatTime(d) : "—";
}

// ─── HOS PLANNING ENGINE (exact audited copy) ──────────────────────
function evaluateHOSPlanning({ drivingHoursAvail, fourteenHourRemaining, cycleHoursRemaining, pickupDateTime, loadingTimeHours, unloadingTimeHours, stops, deadheadMiles, loadedMiles, avgSpeed, preTripMinutes = 15, postTripMinutes = 15 }) {
  const timeline = [], assumptions = [`Planning speed: ${avgSpeed} mph (not actual vehicle speed)`, `Pre-trip inspection: ${preTripMinutes} min`, `Post-trip inspection: ${postTripMinutes} min`, `30-min break modeled before 8th driving hour`, `10-hr rest resets driving (11h) and window (14h); cycle unchanged`, `34-hour restart not modeled`];
  let drivingLeft = drivingHoursAvail, windowLeft = fourteenHourRemaining, cycleLeft = cycleHoursRemaining, hoursSinceBreak = 0, restStopsNeeded = 0, breaksTaken = 0, hardConstraint = null, estimatedArrival = null;
  const preTripHours = preTripMinutes / 60, postTripHours = postTripMinutes / 60;
  const deadheadDriveHours = deadheadMiles > 0 ? deadheadMiles / avgSpeed : 0;
  let currentTime = new Date(pickupDateTime.getTime() - (preTripHours + deadheadDriveHours) * 3600000);
  function addEvent(e, t) { timeline.push({ time: new Date(currentTime), event: e, type: t }); }
  function advance(h) { currentTime = new Date(currentTime.getTime() + h * 3600000); }
  function consumeOnDuty(h) { windowLeft -= h; cycleLeft -= h; }
  function takeBreak() { breaksTaken++; addEvent("30-min break (8h driving reached)", "break"); advance(0.5); windowLeft -= 0.5; hoursSinceBreak = 0; }
  function takeRest() {
    if (cycleLeft <= 0.1) { hardConstraint = `NOT FEASIBLE — insufficient cycle hours to complete planned route. Only ${Math.max(0, cycleLeft).toFixed(1)} cycle hours remain. A 34-hour restart would be needed (not modeled).`; return false; }
    restStopsNeeded++; addEvent("Begin 10-hour rest (planning estimate)", "rest"); advance(10); drivingLeft = 11; windowLeft = 14; hoursSinceBreak = 0;
    addEvent("Resume after 10-hour rest", "depart"); addEvent(`Pre-trip inspection (${preTripMinutes} min)`, "stop"); advance(preTripHours); consumeOnDuty(preTripHours); return true;
  }
  function driveSegment(miles, label) {
    let rem = miles, safe = 0;
    while (rem > 0.05 && safe < 30) {
      safe++;
      const avail = Math.min(drivingLeft, windowLeft, cycleLeft);
      if (avail <= 0.05) { if (cycleLeft <= 0.1) { hardConstraint = `NOT FEASIBLE — cycle hours exhausted during ${label}. ${rem.toFixed(0)} miles remaining.`; return false; } addEvent(`End driving block (HOS limit) — ${(miles - rem).toFixed(0)} mi driven`, "stop"); if (!takeRest()) return false; continue; }
      if (hoursSinceBreak >= 7.95) { addEvent(`Pause driving — ${(miles - rem).toFixed(0)} mi driven so far`, "stop"); takeBreak(); continue; }
      const hfm = rem / avgSpeed, hub = 8 - hoursSinceBreak, dh = Math.min(avail, hfm, hub);
      if (dh <= 0.005) continue;
      const md = dh * avgSpeed; advance(dh); drivingLeft -= dh; windowLeft -= dh; cycleLeft -= dh; hoursSinceBreak += dh; rem -= md;
    }
    if (rem > 0.05) { hardConstraint = `NOT FEASIBLE — could not complete ${label}. ${rem.toFixed(0)} miles remaining.`; return false; }
    return true;
  }
  // Chronological trip model
  addEvent("Go on-duty at current location", "depart"); addEvent(`Pre-trip inspection (${preTripMinutes} min)`, "stop"); advance(preTripHours); consumeOnDuty(preTripHours);
  if (deadheadMiles > 0.5 && !hardConstraint) { addEvent(`Depart — deadhead to pickup (${deadheadMiles.toFixed(0)} mi)`, "depart"); if (!driveSegment(deadheadMiles, "deadhead to pickup")) return buildResult(); addEvent("Arrive at pickup", "arrive"); } else if (!hardConstraint) { addEvent("At pickup location (no deadhead)", "arrive"); }
  if (!hardConstraint) { addEvent(`Begin loading (${loadingTimeHours}h est.)`, "stop"); advance(loadingTimeHours); consumeOnDuty(loadingTimeHours); if (loadingTimeHours >= 0.5) hoursSinceBreak = 0; addEvent("Loading complete — depart pickup", "depart"); }
  if (!hardConstraint) { const as = (stops || []).filter(s => s), ns = as.length, nsg = ns + 1, mps = loadedMiles / nsg; for (let i = 0; i < nsg && !hardConstraint; i++) { const last = i === nsg - 1, sl = last ? "to delivery" : `to stop ${i + 1}`; addEvent(`Drive ${mps.toFixed(0)} mi ${sl}`, "depart"); if (!driveSegment(mps, sl)) return buildResult(); if (!last) { const st = as[i], dw = (st.dwellMinutes || 30) / 60, lb = st.cityState || st.zip || `Stop ${i + 1}`; addEvent(`Arrive at stop ${i + 1}: ${lb}`, "arrive"); addEvent(`Dwell at stop (${(dw * 60).toFixed(0)} min)`, "stop"); advance(dw); consumeOnDuty(dw); if (dw >= 0.5) hoursSinceBreak = 0; } } }
  if (!hardConstraint) { estimatedArrival = new Date(currentTime); addEvent("Arrive at delivery", "arrive"); addEvent(`Begin unloading (${unloadingTimeHours}h est.)`, "stop"); advance(unloadingTimeHours); consumeOnDuty(unloadingTimeHours); addEvent(`Post-trip inspection (${postTripMinutes} min)`, "stop"); advance(postTripHours); consumeOnDuty(postTripHours); addEvent("Off-duty", "rest"); }
  return buildResult();
  function buildResult() { const hosRisk = !hardConstraint && (drivingLeft < 1 || windowLeft < 1 || cycleLeft < 2); return { timeline, assumptions, estimatedArrival: estimatedArrival || new Date(currentTime), drivingHoursRemaining: Math.max(0, drivingLeft), windowRemaining: Math.max(0, windowLeft), cycleRemaining: Math.max(0, cycleLeft), hosRisk, hardConstraint, restStopsNeeded, breaksTaken, feasible: !hardConstraint }; }
}

function evaluateRisks({ deadheadPct, deliveryBufferMins, drivingHoursAvail, loadingTimeHours, unloadingTimeHours, stops, allMileRPM, equipmentType, tempRequired, hazmat, hosResult, thresholds }) {
  const t = thresholds, risks = [];
  if (deadheadPct > t.criticalDeadheadPct) risks.push({ level: "red", label: "Excessive Deadhead", detail: `${deadheadPct.toFixed(1)}% of total miles.` });
  else if (deadheadPct > t.highDeadheadPct) risks.push({ level: "yellow", label: "High Deadhead", detail: `${deadheadPct.toFixed(1)}% of total miles.` });
  if (deliveryBufferMins != null && deliveryBufferMins < 0) risks.push({ level: "red", label: "Late Delivery", detail: `Arrival ${formatMinutes(Math.abs(deliveryBufferMins))} after appointment.` });
  else if (deliveryBufferMins != null && deliveryBufferMins < t.tightBufferMins) risks.push({ level: "yellow", label: "Tight Appointment", detail: `Buffer only ${formatMinutes(deliveryBufferMins)}.` });
  if (hosResult?.hardConstraint) risks.push({ level: "red", label: "HOS Constraint", detail: hosResult.hardConstraint });
  else if (hosResult?.hosRisk) risks.push({ level: "red", label: "HOS Risk", detail: "Very limited driving/on-duty time remaining." });
  if (drivingHoursAvail < 4 && drivingHoursAvail > 0) risks.push({ level: "yellow", label: "Low Driving Hours", detail: `Only ${drivingHoursAvail.toFixed(1)}h available.` });
  if (stops && stops.length > 0) risks.push({ level: "yellow", label: "Multiple Stops", detail: `${stops.length} stop(s).` });
  if (loadingTimeHours > t.longDwellHours) risks.push({ level: "yellow", label: "Long Loading", detail: `${loadingTimeHours}h loading.` });
  if (unloadingTimeHours > t.longDwellHours) risks.push({ level: "yellow", label: "Long Unloading", detail: `${unloadingTimeHours}h unloading.` });
  if (equipmentType === "Dry Van" && tempRequired) risks.push({ level: "red", label: "Equipment Conflict", detail: "Temp freight may need reefer." });
  if (hazmat) risks.push({ level: "yellow", label: "Hazmat", detail: "Verify requirements." });
  if (allMileRPM > 0 && allMileRPM < t.lowRPM) risks.push({ level: "yellow", label: "Low RPM", detail: `${formatCurrencyDecimal(allMileRPM)} below ${formatCurrencyDecimal(t.lowRPM)}.` });
  if (hosResult?.restStopsNeeded > 0) risks.push({ level: "yellow", label: "Rest Required", detail: `${hosResult.restStopsNeeded} rest stop(s).` });
  return risks;
}

function calculateDecisionScore({ deliveryBufferMins, deadheadPct, allMileRPM, risks, hosResult, equipmentConflict, thresholds }) {
  const bd = [];
  let f = 30; if (hosResult?.hardConstraint) f = 0; else if (!hosResult?.feasible && hosResult != null) f = 0; else if (hosResult?.hosRisk) f -= 15; bd.push({ label: "Feasibility", points: Math.max(0, f), max: 30 });
  let m = 20; if (deliveryBufferMins != null) { if (deliveryBufferMins < 0) m = 0; else if (deliveryBufferMins < 30) m = 5; else if (deliveryBufferMins < 60) m = 10; else if (deliveryBufferMins < 120) m = 15; } bd.push({ label: "Schedule Margin", points: m, max: 20 });
  let d = 15; if (deadheadPct > 30) d -= 10; else if (deadheadPct > 20) d -= 7; else if (deadheadPct > 10) d -= 3; bd.push({ label: "Deadhead", points: Math.max(0, d), max: 15 });
  let r = 20; if (allMileRPM > 0 && allMileRPM < thresholds.lowRPM) r -= 12; else if (allMileRPM > 0 && allMileRPM < thresholds.lowRPM * 1.2) r -= 6; bd.push({ label: "RPM", points: Math.max(0, r), max: 20 });
  let c = 10; c -= risks.filter(x => x.level === "red").length * 4; c -= risks.filter(x => x.level === "yellow").length * 1.5; bd.push({ label: "Complexity", points: Math.max(0, Math.round(c)), max: 10 });
  let e = 5; if (equipmentConflict) e = 0; bd.push({ label: "Equipment", points: e, max: 5 });
  const tot = bd.reduce((s, b) => s + b.points, 0);
  return { total: tot, breakdown: bd, viability: tot >= 75 ? "green" : tot >= 50 ? "yellow" : "red", viabilityLabel: tot >= 75 ? "VIABLE" : tot >= 50 ? "TIGHT" : "NOT VIABLE / HIGH RISK" };
}

function calculateNegotiationStrategy({ totalMiles, loadedMiles, offeredRate, targetRPM, minimumRPM, negotiationPremium = 0.05, roundingIncrement = 25 }) {
  if (!totalMiles || totalMiles <= 0 || !offeredRate || offeredRate <= 0) return null;
  const rnd = (v, i) => Math.round(v / i) * i;
  const tgt = rnd(totalMiles * targetRPM, roundingIncrement), min = rnd(totalMiles * minimumRPM, roundingIncrement);
  let ctr = rnd(totalMiles * targetRPM * (1 + negotiationPremium), roundingIncrement);
  if (ctr < offeredRate) ctr = offeredRate; if (ctr < tgt) ctr = tgt;
  const at = offeredRate >= tgt, am = offeredRate >= min, bm = offeredRate < min;
  const rat = [];
  if (at) rat.push("Offered rate meets or exceeds target RPM — strong economics.");
  else if (am) rat.push("Rate is between minimum and target — room to negotiate.");
  else rat.push("Rate is below minimum RPM — significant negotiation needed.");
  rat.push(`Target: ${totalMiles} mi × $${targetRPM.toFixed(2)}/mi = ${formatCurrency(tgt)}.`);
  rat.push(`Minimum: ${totalMiles} mi × $${minimumRPM.toFixed(2)}/mi = ${formatCurrency(min)}.`);
  if (!at) rat.push(`Counter opens at target + ${(negotiationPremium * 100).toFixed(0)}% = ${formatCurrency(ctr)}.`);
  return { offeredRate, offeredAllMileRPM: offeredRate / totalMiles, offeredLoadedRPM: loadedMiles > 0 ? offeredRate / loadedMiles : 0, targetRate: tgt, minimumRate: min, suggestedCounter: ctr, counterAllMileRPM: ctr / totalMiles, aboveTarget: at, aboveMinimum: am, belowMinimum: bm, rationale: rat };
}

function calculateDailyMileage(lm, pd, dd) {
  if (!lm || lm <= 0 || !pd || !dd) return null;
  const p = new Date(pd.getFullYear(), pd.getMonth(), pd.getDate()), d = new Date(dd.getFullYear(), dd.getMonth(), dd.getDate());
  const days = Math.max(1, Math.round((d.getTime() - p.getTime()) / 86400000) + 1);
  return { operationalDays: days, milesPerDay: lm / days, loadedMiles: lm };
}

function evaluateDailyMileageTarget(dm, target, exRPM, rpm) {
  if (!dm) return null;
  const { milesPerDay, operationalDays } = dm, below = milesPerDay < target, exc = rpm >= exRPM, pct = (milesPerDay / target) * 100;
  let lvl = "green", lbl = "On target";
  if (below && exc) { lvl = "green"; lbl = "Below target — strong rate exception"; }
  else if (below && pct >= 80) { lvl = "yellow"; lbl = "Slightly below target"; }
  else if (below) { lvl = "yellow"; lbl = "Below daily mileage target"; }
  return { milesPerDay, operationalDays, target, pctOfTarget: pct, belowTarget: below, rpmException: exc, level: lvl, label: lbl };
}

function evaluateReloadRisk(cs, avoided) {
  if (!cs || !avoided || avoided.length === 0) return null;
  const parts = cs.trim().split(/[,\s]+/), sc = parts[parts.length - 1]?.toUpperCase();
  if (!sc || sc.length !== 2) return null;
  const m = avoided.find(s => s.code.toUpperCase() === sc);
  return m ? { state: sc, severity: m.severity || "warning", isAvoided: true } : null;
}

// ═══════════════════════════════════════════════════════════════════
// DEFAULTS & PERSISTENT STATE
// ═══════════════════════════════════════════════════════════════════

const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split("T")[0]; };
const dayAfter = () => { const d = new Date(); d.setDate(d.getDate() + 2); return d.toISOString().split("T")[0]; };

const DEFAULT_TRUCKS = [
  { id: "327", driverName: "John", currentZip: "76116", drivingHours: "11:00", fourteenHour: "14:00", cycleHours: "52:30" },
];

const DEFAULT_SETTINGS = {
  highDeadheadPct: 15, criticalDeadheadPct: 30, tightBufferMins: 60, longDwellHours: 3,
  lowRPM: 2.50, targetRPM: 3.00, minimumRPM: 2.50, negotiationPremium: 0.05,
  preTripMinutes: 15, postTripMinutes: 15, avgSpeed: 50,
  dailyMilesTarget: 500, shortLoadExceptionRPM: 4.00, avoidedStates: [],
};

const EMPTY = {
  pickupCityState: "", pickupDate: "", pickupTime: "08:00", pickupType: "Appointment", loadingTime: 2,
  deliveryCityState: "", deliveryDate: "", deliveryTime: "14:00", deliveryType: "Appointment", unloadingTime: 1.5,
  deadheadMiles: "", loadedMiles: "", offeredRate: "",
  weight: "", commodity: "",
  pallets: "", pieces: "", hazmat: false, tempRequired: false, specialNotes: "", stops: [],
};

const SAMPLE = {
  pickupCityState: "Dallas, TX", pickupDate: tomorrow(), pickupTime: "08:00", pickupType: "Appointment", loadingTime: 2,
  deliveryCityState: "Atlanta, GA", deliveryDate: dayAfter(), deliveryTime: "14:00", deliveryType: "Appointment", unloadingTime: 1.5,
  deadheadMiles: "35", loadedMiles: "780", offeredRate: "2600",
  weight: "42000", commodity: "Packaged food",
  pallets: "", pieces: "", hazmat: false, tempRequired: false, specialNotes: "", stops: [],
};

// ═══════════════════════════════════════════════════════════════════
// THEME
// ═══════════════════════════════════════════════════════════════════

const P = {
  bg: "#0c0f16", panel: "#141820", border: "#1f2636", inputBg: "#181e2a", inputBd: "#272f40",
  accent: "#3b82f6", tx: "#e2e8f0", t2: "#94a0b8", t3: "#5c6a82",
  green: "#22c55e", gBg: "rgba(34,197,94,0.08)",
  yellow: "#eab308", yBg: "rgba(234,179,8,0.08)",
  red: "#ef4444", rBg: "rgba(239,68,68,0.08)",
  aBg: "rgba(59,130,246,0.06)",
};

// ═══════════════════════════════════════════════════════════════════
// UI PRIMITIVES
// ═══════════════════════════════════════════════════════════════════

const In = ({ value, onChange, type = "text", placeholder, big, style: sx, ...rest }: any) => (
  <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
    style={{ width: "100%", padding: big ? "10px 12px" : "7px 10px", background: P.inputBg, border: `1px solid ${P.inputBd}`, borderRadius: 5, color: P.tx, fontSize: big ? 18 : 14, fontWeight: big ? 700 : 400, outline: "none", boxSizing: "border-box", ...sx }}
    onFocus={e => { e.target.style.borderColor = P.accent; }} onBlur={e => { e.target.style.borderColor = P.inputBd; }} {...rest} />
);

const Sl = ({ value, onChange, options, style: sx }: any) => (
  <select value={value} onChange={e => onChange(e.target.value)}
    style={{ width: "100%", padding: "7px 10px", background: P.inputBg, border: `1px solid ${P.inputBd}`, borderRadius: 5, color: P.tx, fontSize: 14, outline: "none", boxSizing: "border-box", ...sx }}>
    {options.map(o => typeof o === "string" ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>)}
  </select>
);

const Lb = ({ children, hint }: any) => (
  <div style={{ flex: "1 1 140px", minWidth: 100 }}>
    <div style={{ fontSize: 11, color: P.t2, marginBottom: 3, fontWeight: 500 }}>{children}</div>
    {hint && <div style={{ fontSize: 10, color: P.t3, marginTop: 2 }}>{hint}</div>}
  </div>
);

const Fl = ({ label, children, hint }: any) => (
  <div style={{ flex: "1 1 140px", minWidth: 100 }}>
    <div style={{ fontSize: 11, color: P.t2, marginBottom: 3, fontWeight: 500 }}>{label}</div>
    {children}
    {hint && <div style={{ fontSize: 10, color: P.t3, marginTop: 2 }}>{hint}</div>}
  </div>
);

const Rw = ({ children, gap = 10 }: any) => <div style={{ display: "flex", flexWrap: "wrap", gap }}>{children}</div>;

const Box = ({ title, children, compact, style: sx }: any) => (
  <div style={{ background: P.panel, border: `1px solid ${P.border}`, borderRadius: 6, marginBottom: compact ? 8 : 10, ...sx }}>
    {title && <div style={{ padding: "7px 14px", borderBottom: `1px solid ${P.border}`, fontSize: 11, fontWeight: 600, color: P.t2, letterSpacing: "0.04em" }}>{title}</div>}
    <div style={{ padding: compact ? "10px 14px" : "14px" }}>{children}</div>
  </div>
);

const Num = ({ label, value, sub, color, size = 22 }: any) => (
  <div style={{ textAlign: "center", padding: "6px 2px" }}>
    <div style={{ fontSize: 10, color: P.t2, marginBottom: 1 }}>{label}</div>
    <div style={{ fontSize: size, fontWeight: 700, color: color || P.tx, fontVariantNumeric: "tabular-nums", lineHeight: 1.2 }}>{value}</div>
    {sub && <div style={{ fontSize: 10, color: P.t3, marginTop: 1 }}>{sub}</div>}
  </div>
);

// ═══════════════════════════════════════════════════════════════════
// MAIN APPLICATION
// ═══════════════════════════════════════════════════════════════════

export default function App() {
  const [trucks, setTrucks] = useState(DEFAULT_TRUCKS);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [truckId, setTruckId] = useState("327");
  const [load, setLoad] = useState(EMPTY);
  const [analyzed, setAnalyzed] = useState(false);
  const [decision, setDecision] = useState(null);
  const [declineReason, setDeclineReason] = useState("");
  const [showTimeline, setShowTimeline] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showScore, setShowScore] = useState(false);
  const [showWhatIf, setShowWhatIf] = useState(false);
  const [whatIf, setWhatIf] = useState(null);
  const [trainingHide, setTrainingHide] = useState(false);
  const [appliedRate, setAppliedRate] = useState(null);

  // Load persisted data
  useEffect(() => {
    (async () => {
      try {
        const t = { value: typeof window !== "undefined" && localStorage.getItem("dla-trucks") }; if (t?.value) setTrucks(JSON.parse(t.value));
        const s = { value: typeof window !== "undefined" && localStorage.getItem("dla-settings") }; if (s?.value) setSettings(p => ({ ...p, ...JSON.parse(s.value) }));
      } catch (e) { console.log("Storage:", e); }
    })();
  }, []);

  const saveTrucks = async (t) => { setTrucks(t); try { localStorage.setItem("dla-trucks", JSON.stringify(t)); } catch (e) {} };
  const saveSettings = async (s) => { setSettings(s); try { localStorage.setItem("dla-settings", JSON.stringify(s)); } catch (e) {} };

  const truck = trucks.find(t => t.id === truckId) || trucks[0];
  const set = (f, v) => { setLoad(p => ({ ...p, [f]: v })); setAnalyzed(false); setDecision(null); setAppliedRate(null); };
  const selectTruck = (id) => { setTruckId(id); setAnalyzed(false); setDecision(null); };

  const loadSample = () => { setLoad(SAMPLE); setTruckId("327"); setAnalyzed(false); setDecision(null); setAppliedRate(null); };
  const clearAll = () => { setLoad(EMPTY); setAnalyzed(false); setDecision(null); setAppliedRate(null); setShowTimeline(false); };

  const active = whatIf || load;

  // ─── CORE CALCULATIONS ───────────────────────────────────────────
  const calc = useMemo(() => {
    if (!truck) return null;
    const lm = parseFloat(active.loadedMiles) || 0, dm = parseFloat(active.deadheadMiles) || 0;
    const tm = calculateTotalMiles(dm, lm);
    const rate = appliedRate || parseFloat(active.offeredRate) || 0;
    const lRPM = calculateLoadedRPM(rate, lm), aRPM = calculateAllMilesRPM(rate, tm), dhPct = calculateDeadheadPercentage(dm, tm);
    const dha = parseTimeToHours(truck.drivingHours), fhr = parseTimeToHours(truck.fourteenHour), chr = parseTimeToHours(truck.cycleHours);
    const lt = parseFloat(active.loadingTime) || 2, ut = parseFloat(active.unloadingTime) || 1.5, spd = settings.avgSpeed || 50;
    const pDT = parseDateTimeInputs(active.pickupDate, active.pickupTime), dDT = parseDateTimeInputs(active.deliveryDate, active.deliveryTime);

    let hos = null;
    if (pDT && tm > 0) {
      hos = evaluateHOSPlanning({ drivingHoursAvail: dha, fourteenHourRemaining: fhr, cycleHoursRemaining: chr, pickupDateTime: pDT, loadingTimeHours: lt, unloadingTimeHours: ut, stops: active.stops || [], deadheadMiles: dm, loadedMiles: lm, avgSpeed: spd, preTripMinutes: settings.preTripMinutes, postTripMinutes: settings.postTripMinutes });
    }

    const bufMins = hos && dDT ? calculateDeliveryBuffer(hos.estimatedArrival, dDT) : null;
    const risks = evaluateRisks({ deadheadPct: dhPct, deliveryBufferMins: bufMins, drivingHoursAvail: dha, loadingTimeHours: lt, unloadingTimeHours: ut, stops: active.stops || [], allMileRPM: aRPM, equipmentType: "Dry Van", tempRequired: active.tempRequired, hazmat: active.hazmat, hosResult: hos, thresholds: settings });
    const score = calculateDecisionScore({ deliveryBufferMins: bufMins, deadheadPct: dhPct, allMileRPM: aRPM, risks, hosResult: hos, equipmentConflict: active.tempRequired === true, thresholds: settings });
    const neg = calculateNegotiationStrategy({ totalMiles: tm, loadedMiles: lm, offeredRate: parseFloat(active.offeredRate) || 0, targetRPM: settings.targetRPM, minimumRPM: settings.minimumRPM, negotiationPremium: settings.negotiationPremium });
    const dailyMi = calculateDailyMileage(lm, pDT, dDT);
    const miEval = evaluateDailyMileageTarget(dailyMi, settings.dailyMilesTarget, settings.shortLoadExceptionRPM, aRPM);
    const reload = evaluateReloadRisk(active.deliveryCityState, settings.avoidedStates);

    return { lm, dm, tm, rate, lRPM, aRPM, dhPct, lt, ut, spd, hos, bufMins, risks, score, neg, dailyMi, miEval, reload, pDT, dDT, dha };
  }, [active, truck, settings, appliedRate]);

  const analyze = () => { if (calc && calc.tm > 0 && calc.rate > 0) { setAnalyzed(true); setTrainingHide(false); } };
  const applyCounter = (r) => { setAppliedRate(r); setAnalyzed(true); };

  const vc = calc?.score?.viability;
  const vColor = vc === "green" ? P.green : vc === "yellow" ? P.yellow : P.red;
  const vBg = vc === "green" ? P.gBg : vc === "yellow" ? P.yBg : P.rBg;

  // ═══════════════════════════════════════════════════════════════════
  // SETTINGS PAGE
  // ═══════════════════════════════════════════════════════════════════

  if (showSettings) return (
    <div style={{ minHeight: "100vh", background: P.bg, color: P.tx, fontFamily: "'Inter',system-ui,sans-serif", padding: 20, maxWidth: 800, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <span style={{ fontSize: 18, fontWeight: 700 }}>Settings</span>
        <button onClick={() => setShowSettings(false)} style={{ padding: "6px 20px", background: P.accent, border: "none", borderRadius: 6, color: "#fff", fontSize: 13, cursor: "pointer" }}>Done</button>
      </div>

      <Box title="Rate Thresholds">
        <Rw><Fl label="Target RPM ($)"><In type="number" value={settings.targetRPM} onChange={v => saveSettings({ ...settings, targetRPM: parseFloat(v) || 0 })} /></Fl>
        <Fl label="Minimum RPM ($)"><In type="number" value={settings.minimumRPM} onChange={v => saveSettings({ ...settings, minimumRPM: parseFloat(v) || 0 })} /></Fl>
        <Fl label="Low RPM Warning ($)"><In type="number" value={settings.lowRPM} onChange={v => saveSettings({ ...settings, lowRPM: parseFloat(v) || 0 })} /></Fl>
        <Fl label="Negotiation Premium %" hint="Opening above target"><In type="number" value={(settings.negotiationPremium * 100).toFixed(0)} onChange={v => saveSettings({ ...settings, negotiationPremium: (parseFloat(v) || 0) / 100 })} /></Fl></Rw>
      </Box>

      <Box title="Daily Mileage">
        <Rw><Fl label="Daily Miles Target"><In type="number" value={settings.dailyMilesTarget} onChange={v => saveSettings({ ...settings, dailyMilesTarget: parseFloat(v) || 0 })} /></Fl>
        <Fl label="Short Load Exception RPM ($)" hint="RPM above which short loads accepted"><In type="number" value={settings.shortLoadExceptionRPM} onChange={v => saveSettings({ ...settings, shortLoadExceptionRPM: parseFloat(v) || 0 })} /></Fl></Rw>
      </Box>

      <Box title="Deadhead & Schedule">
        <Rw><Fl label="High Deadhead %"><In type="number" value={settings.highDeadheadPct} onChange={v => saveSettings({ ...settings, highDeadheadPct: parseFloat(v) || 0 })} /></Fl>
        <Fl label="Critical Deadhead %"><In type="number" value={settings.criticalDeadheadPct} onChange={v => saveSettings({ ...settings, criticalDeadheadPct: parseFloat(v) || 0 })} /></Fl>
        <Fl label="Tight Buffer (min)"><In type="number" value={settings.tightBufferMins} onChange={v => saveSettings({ ...settings, tightBufferMins: parseFloat(v) || 0 })} /></Fl></Rw>
      </Box>

      <Box title="Planning Assumptions">
        <Rw><Fl label="Avg Speed (MPH)" hint="Not actual speed"><In type="number" value={settings.avgSpeed} onChange={v => saveSettings({ ...settings, avgSpeed: parseFloat(v) || 50 })} /></Fl>
        <Fl label="Pre-trip (min)"><In type="number" value={settings.preTripMinutes} onChange={v => saveSettings({ ...settings, preTripMinutes: parseInt(v) || 0 })} /></Fl>
        <Fl label="Post-trip (min)"><In type="number" value={settings.postTripMinutes} onChange={v => saveSettings({ ...settings, postTripMinutes: parseInt(v) || 0 })} /></Fl></Rw>
      </Box>

      <Box title="States to Avoid (Reload Risk)">
        <div style={{ fontSize: 12, color: P.t2, marginBottom: 8 }}>2-letter state codes. Severity: warning, strong, or block.</div>
        {settings.avoidedStates.map((s, i) => (
          <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center" }}>
            <In value={s.code} onChange={v => { const a = [...settings.avoidedStates]; a[i] = { ...a[i], code: v.toUpperCase() }; saveSettings({ ...settings, avoidedStates: a }); }} style={{ width: 60, flex: "none" }} placeholder="FL" />
            <Sl value={s.severity} onChange={v => { const a = [...settings.avoidedStates]; a[i] = { ...a[i], severity: v }; saveSettings({ ...settings, avoidedStates: a }); }} options={["warning", "strong", "block"]} style={{ width: 120, flex: "none" }} />
            <button onClick={() => saveSettings({ ...settings, avoidedStates: settings.avoidedStates.filter((_, j) => j !== i) })} style={{ background: "none", border: "none", color: P.red, cursor: "pointer", fontSize: 14 }}>✕</button>
          </div>
        ))}
        <button onClick={() => saveSettings({ ...settings, avoidedStates: [...settings.avoidedStates, { code: "", severity: "warning" }] })} style={{ padding: "5px 14px", background: P.aBg, border: `1px dashed ${P.accent}`, borderRadius: 5, color: P.accent, fontSize: 12, cursor: "pointer", marginTop: 4 }}>+ Add State</button>
      </Box>

      <Box title="Truck / Driver Profiles">
        {trucks.map((t, i) => (
          <div key={t.id} style={{ padding: 10, background: P.inputBg, borderRadius: 6, marginBottom: 8, border: `1px solid ${P.inputBd}` }}>
            <Rw><Fl label="Truck #"><In value={t.id} onChange={v => { const a = [...trucks]; a[i] = { ...a[i], id: v }; saveTrucks(a); }} /></Fl>
            <Fl label="Driver"><In value={t.driverName} onChange={v => { const a = [...trucks]; a[i] = { ...a[i], driverName: v }; saveTrucks(a); }} /></Fl>
            <Fl label="Current ZIP"><In value={t.currentZip} onChange={v => { const a = [...trucks]; a[i] = { ...a[i], currentZip: v }; saveTrucks(a); }} /></Fl></Rw>
            <Rw><Fl label="Driving Hours" hint="HH:MM"><In value={t.drivingHours} onChange={v => { const a = [...trucks]; a[i] = { ...a[i], drivingHours: v }; saveTrucks(a); }} /></Fl>
            <Fl label="14-Hr Window" hint="HH:MM"><In value={t.fourteenHour} onChange={v => { const a = [...trucks]; a[i] = { ...a[i], fourteenHour: v }; saveTrucks(a); }} /></Fl>
            <Fl label="Cycle Hours" hint="HH:MM"><In value={t.cycleHours} onChange={v => { const a = [...trucks]; a[i] = { ...a[i], cycleHours: v }; saveTrucks(a); }} /></Fl></Rw>
            {trucks.length > 1 && <button onClick={() => saveTrucks(trucks.filter((_, j) => j !== i))} style={{ marginTop: 6, background: "none", border: "none", color: P.red, cursor: "pointer", fontSize: 12 }}>Remove truck</button>}
          </div>
        ))}
        <button onClick={() => saveTrucks([...trucks, { id: String(100 + trucks.length), driverName: "", currentZip: "", drivingHours: "11:00", fourteenHour: "14:00", cycleHours: "70:00" }])} style={{ padding: "5px 14px", background: P.aBg, border: `1px dashed ${P.accent}`, borderRadius: 5, color: P.accent, fontSize: 12, cursor: "pointer" }}>+ Add Truck</button>
      </Box>
    </div>
  );

  // ═══════════════════════════════════════════════════════════════════
  // MAIN DISPATCH SCREEN
  // ═══════════════════════════════════════════════════════════════════

  return (
    <div style={{ minHeight: "100vh", background: P.bg, color: P.tx, fontFamily: "'Inter',system-ui,sans-serif" }}>

      {/* ─── HEADER ─── */}
      <div style={{ background: P.panel, borderBottom: `1px solid ${P.border}`, padding: "8px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: 4, background: analyzed ? P.green : P.t3 }} />
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.01em" }}>Dispatch Load Analyzer</span>
          <span style={{ fontSize: 10, color: P.t3, padding: "1px 6px", border: `1px solid ${P.border}`, borderRadius: 3 }}>Dry Van</span>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 11, color: P.t2, display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
            <input type="checkbox" checked={trainingHide} onChange={e => { setTrainingHide(e.target.checked); if (e.target.checked) setAnalyzed(false); }} style={{ accentColor: P.accent }} />Training
          </label>
          <button onClick={loadSample} style={{ padding: "4px 10px", background: P.aBg, border: `1px solid ${P.accent}`, borderRadius: 4, color: P.accent, fontSize: 11, cursor: "pointer", fontWeight: 500 }}>Demo</button>
          <button onClick={clearAll} style={{ padding: "4px 10px", background: "transparent", border: `1px solid ${P.inputBd}`, borderRadius: 4, color: P.t2, fontSize: 11, cursor: "pointer" }}>Clear</button>
          <button onClick={() => setShowSettings(true)} style={{ padding: "4px 10px", background: "transparent", border: `1px solid ${P.inputBd}`, borderRadius: 4, color: P.t2, fontSize: 11, cursor: "pointer" }}>⚙ Settings</button>
        </div>
      </div>

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "12px 16px 60px" }}>
        <div style={{ display: "grid", gridTemplateColumns: analyzed ? "1fr 1fr" : "1fr", gap: 14, alignItems: "start" }}>

          {/* ═══ LEFT: FAST ENTRY FORM ═══ */}
          <div style={{ minWidth: 0 }}>

            {/* TRUCK SELECTOR */}
            <Box title="Truck" compact>
              <Sl value={truckId} onChange={selectTruck} options={trucks.map(t => ({ value: t.id, label: `${t.id} — ${t.driverName || "(no driver)"}` }))} />
              {truck && (
                <div style={{ marginTop: 6, display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11, color: P.t2 }}>
                  <span>{truck.driverName} · ZIP {truck.currentZip}</span>
                  <span>Drive <b style={{ color: P.tx }}>{truck.drivingHours}</b></span>
                  <span>Window <b style={{ color: P.tx }}>{truck.fourteenHour}</b></span>
                  <span>Cycle <b style={{ color: P.tx }}>{truck.cycleHours}</b></span>
                </div>
              )}
            </Box>

            {/* PICKUP */}
            <Box title="Pickup" compact>
              <Rw>
                <Fl label="City / ZIP"><In value={load.pickupCityState} onChange={v => set("pickupCityState", v)} placeholder="Dallas, TX" /></Fl>
                <Fl label="Date"><In type="date" value={load.pickupDate} onChange={v => set("pickupDate", v)} /></Fl>
                <Fl label="Time"><In type="time" value={load.pickupTime} onChange={v => set("pickupTime", v)} /></Fl>
              </Rw>
              <Rw>
                <Fl label="Type"><Sl value={load.pickupType} onChange={v => set("pickupType", v)} options={["Appointment", "FCFS", "Window"]} /></Fl>
                <Fl label="Loading (hrs)"><In type="number" value={load.loadingTime} onChange={v => set("loadingTime", v)} placeholder="2" /></Fl>
              </Rw>
            </Box>

            {/* DELIVERY */}
            <Box title="Delivery" compact>
              <Rw>
                <Fl label="City / ZIP"><In value={load.deliveryCityState} onChange={v => set("deliveryCityState", v)} placeholder="Atlanta, GA" /></Fl>
                <Fl label="Date"><In type="date" value={load.deliveryDate} onChange={v => set("deliveryDate", v)} /></Fl>
                <Fl label="Time"><In type="time" value={load.deliveryTime} onChange={v => set("deliveryTime", v)} /></Fl>
              </Rw>
              <Rw>
                <Fl label="Type"><Sl value={load.deliveryType} onChange={v => set("deliveryType", v)} options={["Appointment", "FCFS", "Window"]} /></Fl>
                <Fl label="Unloading (hrs)"><In type="number" value={load.unloadingTime} onChange={v => set("unloadingTime", v)} placeholder="1.5" /></Fl>
              </Rw>
            </Box>

            {/* DISTANCE + RATE + FREIGHT */}
            <Box title="Distance · Rate · Freight" compact>
              <Rw>
                <Fl label="Deadhead Miles" hint="Manual est."><In type="number" value={load.deadheadMiles} onChange={v => set("deadheadMiles", v)} placeholder="35" /></Fl>
                <Fl label="Loaded Miles" hint="Manual est."><In type="number" value={load.loadedMiles} onChange={v => set("loadedMiles", v)} placeholder="780" /></Fl>
                <Fl label="Broker Offer ($)"><In type="number" value={load.offeredRate} onChange={v => set("offeredRate", v)} placeholder="2600" big /></Fl>
              </Rw>
              <Rw>
                <Fl label="Weight (lbs)"><In type="number" value={load.weight} onChange={v => set("weight", v)} placeholder="42000" /></Fl>
                <Fl label="Commodity"><In value={load.commodity} onChange={v => set("commodity", v)} placeholder="Packaged food" /></Fl>
              </Rw>
            </Box>

            {/* ANALYZE */}
            <button onClick={analyze} disabled={!calc || calc.tm <= 0 || calc.rate <= 0}
              style={{ width: "100%", padding: 14, marginTop: 2, background: P.accent, border: "none", borderRadius: 8, color: "#fff", fontSize: 16, fontWeight: 700, cursor: "pointer", opacity: (!calc || calc.tm <= 0 || calc.rate <= 0) ? 0.35 : 1, letterSpacing: "0.02em" }}>
              ANALYZE LOAD
            </button>

            {/* ADVANCED DETAILS (collapsed) */}
            <div style={{ marginTop: 10 }}>
              <button onClick={() => setShowAdvanced(!showAdvanced)} style={{ background: "none", border: "none", color: P.t3, fontSize: 11, cursor: "pointer", padding: 0 }}>
                {showAdvanced ? "— Hide" : "+"} Advanced Details
              </button>
              {showAdvanced && (
                <div style={{ marginTop: 6, padding: 12, background: P.panel, border: `1px solid ${P.border}`, borderRadius: 6 }}>
                  <Rw><Fl label="Pallets"><In type="number" value={load.pallets} onChange={v => set("pallets", v)} /></Fl>
                  <Fl label="Pieces"><In type="number" value={load.pieces} onChange={v => set("pieces", v)} /></Fl></Rw>
                  <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
                    <label style={{ fontSize: 12, color: P.t2, display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}><input type="checkbox" checked={load.hazmat} onChange={e => set("hazmat", e.target.checked)} />Hazmat</label>
                    <label style={{ fontSize: 12, color: P.t2, display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}><input type="checkbox" checked={load.tempRequired} onChange={e => set("tempRequired", e.target.checked)} />Temp Required</label>
                  </div>
                  <div style={{ marginTop: 8 }}><Fl label="Special Notes"><In value={load.specialNotes} onChange={v => set("specialNotes", v)} /></Fl></div>

                  {/* Stops */}
                  <div style={{ marginTop: 10, borderTop: `1px solid ${P.border}`, paddingTop: 8 }}>
                    <div style={{ fontSize: 11, color: P.t2, marginBottom: 4 }}>Stops ({load.stops.length})</div>
                    {load.stops.map((s, i) => (
                      <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4, alignItems: "center" }}>
                        <In value={s.cityState || ""} onChange={v => { const a = [...load.stops]; a[i] = { ...a[i], cityState: v }; set("stops", a); }} placeholder="City, ST" style={{ flex: 1 }} />
                        <In type="number" value={s.dwellMinutes || 30} onChange={v => { const a = [...load.stops]; a[i] = { ...a[i], dwellMinutes: parseInt(v) || 0 }; set("stops", a); }} placeholder="min" style={{ width: 60, flex: "none" }} />
                        <button onClick={() => set("stops", load.stops.filter((_, j) => j !== i))} style={{ background: "none", border: "none", color: P.red, cursor: "pointer" }}>✕</button>
                      </div>
                    ))}
                    <button onClick={() => set("stops", [...load.stops, { cityState: "", dwellMinutes: 30 }])} style={{ padding: "4px 12px", background: P.aBg, border: `1px dashed ${P.accent}`, borderRadius: 4, color: P.accent, fontSize: 11, cursor: "pointer" }}>+ Stop</button>
                  </div>

                  {/* What-If */}
                  <div style={{ marginTop: 10, borderTop: `1px solid ${P.border}`, paddingTop: 8 }}>
                    {!showWhatIf ? (
                      <button onClick={() => { setShowWhatIf(true); setWhatIf({ ...load }); }} style={{ padding: "4px 12px", background: P.aBg, border: `1px dashed ${P.accent}`, borderRadius: 4, color: P.accent, fontSize: 11, cursor: "pointer" }}>Enter What-If Mode</button>
                    ) : (
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                          <span style={{ fontSize: 12, color: P.accent, fontWeight: 600 }}>What-If (temporary)</span>
                          <button onClick={() => { setShowWhatIf(false); setWhatIf(null); }} style={{ padding: "3px 10px", background: P.accent, border: "none", borderRadius: 4, color: "#fff", fontSize: 11, cursor: "pointer" }}>Exit</button>
                        </div>
                        <Rw>
                          <Fl label="Rate"><In type="number" value={whatIf?.offeredRate || ""} onChange={v => setWhatIf(p => ({ ...p, offeredRate: v }))} /></Fl>
                          <Fl label="Deadhead"><In type="number" value={whatIf?.deadheadMiles || ""} onChange={v => setWhatIf(p => ({ ...p, deadheadMiles: v }))} /></Fl>
                          <Fl label="Loaded"><In type="number" value={whatIf?.loadedMiles || ""} onChange={v => setWhatIf(p => ({ ...p, loadedMiles: v }))} /></Fl>
                        </Rw>
                        <Rw>
                          <Fl label="Loading (h)"><In type="number" value={whatIf?.loadingTime || ""} onChange={v => setWhatIf(p => ({ ...p, loadingTime: v }))} /></Fl>
                          <Fl label="Unloading (h)"><In type="number" value={whatIf?.unloadingTime || ""} onChange={v => setWhatIf(p => ({ ...p, unloadingTime: v }))} /></Fl>
                          <Fl label="PU Time"><In type="time" value={whatIf?.pickupTime || ""} onChange={v => setWhatIf(p => ({ ...p, pickupTime: v }))} /></Fl>
                          <Fl label="Del Time"><In type="time" value={whatIf?.deliveryTime || ""} onChange={v => setWhatIf(p => ({ ...p, deliveryTime: v }))} /></Fl>
                        </Rw>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ═══ RIGHT: ANALYSIS RESULTS ═══ */}
          {analyzed && calc && (
            <div style={{ minWidth: 0 }}>

              {/* VIABILITY BANNER */}
              <div style={{ padding: "14px 18px", background: calc.hos?.hardConstraint ? P.rBg : vBg, border: `2px solid ${calc.hos?.hardConstraint ? P.red : vColor}`, borderRadius: 8, marginBottom: 10, display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ width: 14, height: 14, borderRadius: 7, background: calc.hos?.hardConstraint ? P.red : vColor, boxShadow: `0 0 10px ${calc.hos?.hardConstraint ? P.red : vColor}`, flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: calc.hos?.hardConstraint ? P.red : vColor }}>{calc.hos?.hardConstraint ? "NOT FEASIBLE" : calc.score.viabilityLabel}</div>
                  <div style={{ fontSize: 12, color: P.t2 }}>{calc.hos?.hardConstraint || `Score: ${calc.score.total}/100`}</div>
                </div>
              </div>

              {/* TRAINING: HIDE ANALYSIS UNTIL REVEAL */}
              {trainingHide && (
                <div style={{ textAlign: "center", padding: 24, background: P.panel, border: `1px solid ${P.border}`, borderRadius: 8, marginBottom: 10 }}>
                  <div style={{ fontSize: 13, color: P.t2, marginBottom: 12 }}>Make your decision first, then reveal the full analysis.</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
                    <button onClick={() => { setDecision("accept"); setTrainingHide(false); }} style={{ padding: 10, background: P.gBg, border: `2px solid ${P.green}`, borderRadius: 6, color: P.green, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>ACCEPT</button>
                    <button onClick={() => { setDecision("negotiate"); setTrainingHide(false); }} style={{ padding: 10, background: P.yBg, border: `2px solid ${P.yellow}`, borderRadius: 6, color: P.yellow, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>NEGOTIATE</button>
                    <button onClick={() => { setDecision("decline"); setTrainingHide(false); }} style={{ padding: 10, background: P.rBg, border: `2px solid ${P.red}`, borderRadius: 6, color: P.red, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>DECLINE</button>
                  </div>
                  <button onClick={() => setTrainingHide(false)} style={{ padding: "8px 24px", background: P.accent, border: "none", borderRadius: 6, color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Reveal Analysis</button>
                </div>
              )}

              {/* ECONOMICS */}
              {!trainingHide && (
                <Box title="Economics" compact>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4, textAlign: "center" }}>
                    <Num label="All-Mile RPM" value={formatCurrencyDecimal(calc.aRPM)} color={calc.aRPM >= settings.targetRPM ? P.green : calc.aRPM >= settings.minimumRPM ? P.yellow : P.red} />
                    <Num label="Loaded RPM" value={formatCurrencyDecimal(calc.lRPM)} />
                    <Num label="Rate" value={formatCurrency(calc.rate)} color={P.green} />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4, textAlign: "center", marginTop: 4 }}>
                    <Num label="Deadhead" value={`${calc.dhPct.toFixed(1)}%`} sub={`${calc.dm} mi`} color={calc.dhPct > settings.highDeadheadPct ? P.yellow : P.tx} />
                    <Num label="Buffer" value={calc.bufMins != null ? formatMinutes(calc.bufMins) : "—"} color={calc.bufMins != null ? (calc.bufMins < 0 ? P.red : calc.bufMins < 60 ? P.yellow : P.green) : P.t3} />
                    <Num label="Total Miles" value={calc.tm} sub={`${calc.lm} loaded`} />
                  </div>
                </Box>
              )}

              {/* DAILY MILEAGE */}
              {!trainingHide && calc.miEval && (
                <div style={{ padding: "6px 14px", background: calc.miEval.level === "green" ? P.gBg : P.yBg, border: `1px solid ${calc.miEval.level === "green" ? P.green : P.yellow}`, borderRadius: 5, marginBottom: 8, fontSize: 12 }}>
                  <span style={{ color: calc.miEval.level === "green" ? P.green : P.yellow, fontWeight: 600 }}>{Math.round(calc.miEval.milesPerDay)} / {calc.miEval.target} mi/day</span>
                  <span style={{ color: P.t2, marginLeft: 8 }}>({calc.miEval.operationalDays}d) — {calc.miEval.label}</span>
                </div>
              )}

              {/* RELOAD RISK */}
              {!trainingHide && calc.reload && (
                <div style={{ padding: "6px 14px", background: calc.reload.severity === "block" ? P.rBg : P.yBg, border: `1px solid ${calc.reload.severity === "block" ? P.red : P.yellow}`, borderRadius: 5, marginBottom: 8, fontSize: 12 }}>
                  <span style={{ color: calc.reload.severity === "block" ? P.red : P.yellow, fontWeight: 600 }}>
                    {calc.reload.severity === "block" ? "BLOCKED" : "RELOAD RISK"} — {calc.reload.state}
                  </span>
                  <div style={{ color: P.t2, marginTop: 2 }}>Destination in configured avoided state{calc.reload.severity !== "block" ? " — may create outbound difficulty" : ""}.</div>
                </div>
              )}

              {/* HOS SUMMARY */}
              {!trainingHide && (
                <div style={{ padding: "7px 14px", background: P.panel, border: `1px solid ${P.border}`, borderRadius: 5, marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontSize: 12 }}>
                    <span style={{ color: P.t2 }}>HOS </span>
                    {calc.hos?.hardConstraint ? <span style={{ color: P.red, fontWeight: 600 }}>NOT FEASIBLE</span>
                      : calc.hos?.hosRisk ? <span style={{ color: P.red, fontWeight: 600 }}>AT RISK</span>
                      : <span style={{ color: P.green, fontWeight: 600 }}>FEASIBLE</span>}
                    {calc.hos && !calc.hos.hardConstraint && <span style={{ color: P.t3, marginLeft: 8, fontSize: 11 }}>{calc.hos.restStopsNeeded} rest · {calc.hos.breaksTaken} break</span>}
                  </div>
                  {calc.hos && <button onClick={() => setShowTimeline(!showTimeline)} style={{ background: "none", border: `1px solid ${P.inputBd}`, borderRadius: 4, color: P.t2, fontSize: 11, cursor: "pointer", padding: "2px 8px" }}>{showTimeline ? "Hide" : "View"} Timeline</button>}
                </div>
              )}

              {/* HOS TIMELINE (expandable) */}
              {showTimeline && calc.hos && (
                <div style={{ background: P.panel, border: `1px solid ${P.border}`, borderRadius: 5, padding: 10, marginBottom: 8, maxHeight: 260, overflowY: "auto" }}>
                  <div style={{ fontSize: 10, color: P.t3, marginBottom: 4 }}>Planning timeline — not an HOS log</div>
                  {calc.hos.timeline.map((e, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, marginBottom: 3, fontSize: 11 }}>
                      <span style={{ width: 6, height: 6, borderRadius: 3, marginTop: 4, flexShrink: 0, background: e.type === "rest" || e.type === "break" ? P.yellow : e.type === "arrive" ? P.green : e.type === "depart" ? P.accent : P.t3 }} />
                      <span style={{ color: P.t2, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{formatDateTime(e.time)}</span>
                      <span style={{ color: P.tx }}>{e.event}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* RISKS */}
              {!trainingHide && calc.risks.length > 0 && (
                <Box title={`Risks (${calc.risks.length})`} compact>
                  {calc.risks.map((r, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, padding: "5px 10px", background: r.level === "red" ? P.rBg : P.yBg, border: `1px solid ${r.level === "red" ? P.red : P.yellow}`, borderRadius: 4, marginBottom: 4, fontSize: 12 }}>
                      <span style={{ width: 6, height: 6, borderRadius: 3, marginTop: 5, flexShrink: 0, background: r.level === "red" ? P.red : P.yellow }} />
                      <div><span style={{ fontWeight: 600, color: r.level === "red" ? P.red : P.yellow }}>{r.label}</span> <span style={{ color: P.t2 }}>{r.detail}</span></div>
                    </div>
                  ))}
                </Box>
              )}

              {/* NEGOTIATION STRATEGY */}
              {!trainingHide && calc.neg && (
                <Box title="Negotiation Strategy" compact>
                  {calc.neg.aboveTarget ? (
                    <div style={{ textAlign: "center", padding: 8 }}>
                      <div style={{ fontSize: 14, color: P.green, fontWeight: 700, marginBottom: 4 }}>Rate meets target — strong economics</div>
                      <div style={{ fontSize: 12, color: P.t2 }}>All-mile {formatCurrencyDecimal(calc.neg.offeredAllMileRPM)} ≥ target {formatCurrencyDecimal(settings.targetRPM)}</div>
                    </div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, textAlign: "center", marginBottom: 8 }}>
                      <div style={{ background: P.gBg, borderRadius: 6, padding: "10px 6px" }}>
                        <div style={{ fontSize: 10, color: P.t2 }}>Suggested Counter</div>
                        <div style={{ fontSize: 22, fontWeight: 800, color: P.green }}>{formatCurrency(calc.neg.suggestedCounter)}</div>
                        <div style={{ fontSize: 10, color: P.t3 }}>{formatCurrencyDecimal(calc.neg.counterAllMileRPM)}/mi</div>
                      </div>
                      <div style={{ background: P.aBg, borderRadius: 6, padding: "10px 6px" }}>
                        <div style={{ fontSize: 10, color: P.t2 }}>Target</div>
                        <div style={{ fontSize: 22, fontWeight: 700, color: P.accent }}>{formatCurrency(calc.neg.targetRate)}</div>
                        <div style={{ fontSize: 10, color: P.t3 }}>{formatCurrencyDecimal(settings.targetRPM)}/mi</div>
                      </div>
                      <div style={{ background: P.rBg, borderRadius: 6, padding: "10px 6px" }}>
                        <div style={{ fontSize: 10, color: P.t2 }}>Minimum</div>
                        <div style={{ fontSize: 22, fontWeight: 700, color: P.red }}>{formatCurrency(calc.neg.minimumRate)}</div>
                        <div style={{ fontSize: 10, color: P.t3 }}>{formatCurrencyDecimal(settings.minimumRPM)}/mi</div>
                      </div>
                    </div>
                  )}
                  {!calc.neg.aboveTarget && (
                    <button onClick={() => applyCounter(calc.neg.suggestedCounter)} style={{ width: "100%", padding: 8, background: P.green, border: "none", borderRadius: 6, color: "#000", fontSize: 13, fontWeight: 700, cursor: "pointer", marginBottom: 6 }}>
                      Apply {formatCurrency(calc.neg.suggestedCounter)} Counter
                    </button>
                  )}
                  {appliedRate && (
                    <div style={{ textAlign: "center", padding: 6, background: P.gBg, borderRadius: 4, fontSize: 12, color: P.green, marginBottom: 6 }}>
                      Applied rate: {formatCurrency(appliedRate)} — All-mile RPM: {formatCurrencyDecimal(calc.aRPM)}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: P.t3 }}>
                    {calc.neg.rationale.map((r, i) => <div key={i}>• {r}</div>)}
                    <div style={{ marginTop: 3, fontStyle: "italic" }}>Based on configured thresholds, not market data.</div>
                  </div>
                </Box>
              )}

              {/* SCORE BREAKDOWN (collapsed) */}
              {!trainingHide && (
                <div style={{ marginBottom: 8 }}>
                  <button onClick={() => setShowScore(!showScore)} style={{ background: "none", border: "none", color: P.t3, fontSize: 11, cursor: "pointer", padding: 0 }}>{showScore ? "—" : "+"} Score Breakdown</button>
                  {showScore && (
                    <div style={{ marginTop: 4, padding: 10, background: P.panel, border: `1px solid ${P.border}`, borderRadius: 5 }}>
                      {calc.score.breakdown.map((b, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 3 }}>
                          <span style={{ flex: 1, color: P.t2 }}>{b.label}</span>
                          <div style={{ width: 80, height: 5, background: P.inputBg, borderRadius: 3, overflow: "hidden" }}>
                            <div style={{ width: `${(b.points / b.max) * 100}%`, height: "100%", background: b.points === b.max ? P.green : b.points > b.max * 0.5 ? P.yellow : P.red, borderRadius: 3 }} />
                          </div>
                          <span style={{ width: 40, textAlign: "right", color: P.tx, fontVariantNumeric: "tabular-nums" }}>{b.points}/{b.max}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* DECISION */}
              <Box title="Decision" compact>
                {!decision ? (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    <button onClick={() => setDecision("accept")} style={{ padding: 12, background: P.gBg, border: `2px solid ${P.green}`, borderRadius: 6, color: P.green, fontSize: 15, fontWeight: 700, cursor: "pointer" }}>ACCEPT</button>
                    <button onClick={() => setDecision("negotiate")} style={{ padding: 12, background: P.yBg, border: `2px solid ${P.yellow}`, borderRadius: 6, color: P.yellow, fontSize: 15, fontWeight: 700, cursor: "pointer" }}>NEGOTIATE</button>
                    <button onClick={() => setDecision("decline")} style={{ padding: 12, background: P.rBg, border: `2px solid ${P.red}`, borderRadius: 6, color: P.red, fontSize: 15, fontWeight: 700, cursor: "pointer" }}>DECLINE</button>
                  </div>
                ) : (
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: decision === "accept" ? P.green : decision === "negotiate" ? P.yellow : P.red, marginBottom: 6 }}>
                      {decision === "accept" ? "ACCEPTED" : decision === "negotiate" ? "NEGOTIATING" : "DECLINED"}
                    </div>
                    {decision === "decline" && (
                      <div style={{ marginBottom: 8 }}><Sl value={declineReason} onChange={setDeclineReason} options={["", "Low rate", "Too much deadhead", "HOS", "Tight delivery", "Bad destination", "Equipment", "Too many stops", "Other"]} style={{ maxWidth: 200, margin: "0 auto" }} /></div>
                    )}
                    <div style={{ fontSize: 12, color: P.t2, marginBottom: 8 }}>{formatCurrency(calc.rate)} · {calc.tm} mi · {formatCurrencyDecimal(calc.aRPM)}/mi</div>
                    <button onClick={() => setDecision(null)} style={{ padding: "4px 14px", background: "transparent", border: `1px solid ${P.inputBd}`, borderRadius: 4, color: P.t2, fontSize: 11, cursor: "pointer" }}>Change</button>
                  </div>
                )}
              </Box>
            </div>
          )}
        </div>

        <div style={{ textAlign: "center", marginTop: 20, fontSize: 10, color: P.t3, lineHeight: 1.5 }}>
          Dispatch Load Analyzer v2 — Planning tool only. Not a substitute for ELD, HOS compliance, or company dispatch software. Verify through your company's systems.
        </div>
      </div>
    </div>
  );
}
