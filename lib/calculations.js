/**
 * Dispatch Load Analyzer — Calculation Engine
 *
 * All functions are pure (no side effects, no UI dependencies).
 * Each function documents its inputs, outputs, and assumptions.
 *
 * IMPORTANT: This is a PLANNING tool. Nothing produced here constitutes
 * a legal HOS determination. The dispatcher must verify actual HOS/ELD
 * information and company procedures.
 */

// ─── BASIC CALCULATIONS ────────────────────────────────────────────

function calculateTotalMiles(deadheadMiles, loadedMiles) {
  return (deadheadMiles || 0) + (loadedMiles || 0);
}

function calculateLoadedRPM(rate, loadedMiles) {
  if (!loadedMiles || loadedMiles <= 0 || !rate || rate < 0) return 0;
  return rate / loadedMiles;
}

function calculateAllMilesRPM(rate, totalMiles) {
  if (!totalMiles || totalMiles <= 0 || !rate || rate < 0) return 0;
  return rate / totalMiles;
}

function calculateDeadheadPercentage(deadheadMiles, totalMiles) {
  if (!totalMiles || totalMiles <= 0) return 0;
  return ((deadheadMiles || 0) / totalMiles) * 100;
}

function calculateEstimatedDrivingTime(miles, avgSpeed) {
  if (!miles || miles <= 0 || !avgSpeed || avgSpeed <= 0) return 0;
  return miles / avgSpeed;
}

/**
 * Returns delivery buffer in minutes.
 * Positive = early. Negative = late.
 */
function calculateDeliveryBuffer(estimatedArrival, deliveryDateTime) {
  if (!estimatedArrival || !deliveryDateTime) return null;
  return (deliveryDateTime.getTime() - estimatedArrival.getTime()) / (1000 * 60);
}

// ─── PARSING ────────────────────────────────────────────────────────

/**
 * Parses "HH:MM" string to decimal hours.
 * "11:00" → 11.0, "52:30" → 52.5
 */
function parseTimeToHours(str) {
  if (!str) return 0;
  const parts = str.split(":");
  return (parseFloat(parts[0]) || 0) + (parseFloat(parts[1]) || 0) / 60;
}

/**
 * Creates a Date in LOCAL timezone from date string + time string.
 * Uses the Date constructor with explicit numeric arguments to avoid
 * ambiguous ISO string parsing across environments.
 *
 * "2026-09-04", "08:00" → new Date(2026, 8, 4, 8, 0) (local time)
 */
function parseDateTimeInputs(dateStr, timeStr) {
  if (!dateStr) return null;
  const t = timeStr || "08:00";
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = t.split(":").map(Number);
  return new Date(year, month - 1, day, hour || 0, minute || 0);
}

// ─── HOS PLANNING ENGINE ───────────────────────────────────────────

/**
 * Simulates a complete trip chronologically and produces a planning
 * timeline, estimated arrival, and HOS resource consumption.
 *
 * DOCUMENTED ASSUMPTIONS:
 *  1. Planning speed is a constant average — no acceleration, traffic,
 *     fuel stops, or speed variations.
 *  2. 30-minute break is required before the 8th cumulative driving hour.
 *     Any 30+ consecutive minutes of non-driving time (on-duty or off-duty)
 *     satisfies this requirement. (FMCSA §395.3(a)(3)(ii), 2020 revision)
 *  3. 10-hour rest resets driving hours to 11 and the 14-hour window to 14.
 *     It does NOT reset the 60/70-hour cycle.
 *  4. The 14-hour window runs continuously from the moment the driver goes
 *     on-duty. It does NOT pause for off-duty time (breaks) within a duty
 *     period. Only a qualifying 10-hour rest resets it.
 *  5. 30-minute breaks are off-duty: they consume elapsed time and
 *     14-hour window time, but NOT cycle hours or driving hours.
 *  6. Loading, unloading, stop dwell, and inspections are on-duty not
 *     driving: they consume 14-hour window AND cycle hours, but NOT
 *     driving hours.
 *  7. 34-hour restart is NOT modeled. If cycle hours are exhausted, the
 *     engine returns a hard constraint.
 *  8. Split sleeper berth is NOT modeled.
 *  9. Adverse driving conditions exception is NOT modeled.
 * 10. Short-haul exception is NOT modeled.
 * 11. When stops exist, loaded miles are divided equally among route
 *     segments (pickup→stop1, stop1→stop2, ..., stopN→delivery).
 *     This is a simplification; actual segment distances may vary.
 * 12. HOS values entered represent the driver's available hours at trip
 *     departure (when going on-duty).
 * 13. The driver departs early enough to complete pre-trip inspection
 *     and deadhead driving, arriving at pickup at the scheduled time.
 *
 * @param {Object} params
 * @param {number} params.drivingHoursAvail      - User input: hours from ELD
 * @param {number} params.fourteenHourRemaining  - User input: hours from ELD
 * @param {number} params.cycleHoursRemaining    - User input: hours from ELD
 * @param {Date}   params.pickupDateTime          - User input: scheduled pickup
 * @param {number} params.loadingTimeHours        - User input (default 2)
 * @param {number} params.unloadingTimeHours      - User input (default 1.5)
 * @param {Array}  params.stops                   - User input: intermediate stops
 * @param {number} params.deadheadMiles           - User input: current loc → pickup
 * @param {number} params.loadedMiles             - User input: pickup → delivery
 * @param {number} params.avgSpeed                - Planning assumption (default 50)
 * @param {number} params.preTripMinutes          - Planning assumption (default 15)
 * @param {number} params.postTripMinutes         - Planning assumption (default 15)
 *
 * @returns {Object} Planning result
 */
function evaluateHOSPlanning({
  drivingHoursAvail,
  fourteenHourRemaining,
  cycleHoursRemaining,
  pickupDateTime,
  loadingTimeHours,
  unloadingTimeHours,
  stops,
  deadheadMiles,
  loadedMiles,
  avgSpeed,
  preTripMinutes = 15,
  postTripMinutes = 15,
}) {
  const timeline = [];
  const assumptions = [
    `Planning speed: ${avgSpeed} mph (not actual vehicle speed)`,
    `Pre-trip inspection: ${preTripMinutes} min`,
    `Post-trip inspection: ${postTripMinutes} min`,
    `30-min break modeled before 8th driving hour`,
    `10-hr rest resets driving (11h) and window (14h); cycle unchanged`,
    `34-hour restart not modeled`,
  ];

  // ─── HOS state ───
  let drivingLeft = drivingHoursAvail;
  let windowLeft = fourteenHourRemaining;
  let cycleLeft = cycleHoursRemaining;
  let hoursSinceBreak = 0;   // cumulative driving since last 30+ min non-driving
  let restStopsNeeded = 0;
  let breaksTaken = 0;
  let hardConstraint = null;
  let estimatedArrival = null;

  // ─── Time tracking ───
  const preTripHours = preTripMinutes / 60;
  const postTripHours = postTripMinutes / 60;
  const deadheadDriveHours = deadheadMiles > 0 ? deadheadMiles / avgSpeed : 0;

  // Departure time: work backwards from pickup to allow pre-trip + deadhead
  let currentTime = new Date(
    pickupDateTime.getTime() - (preTripHours + deadheadDriveHours) * 3600000
  );

  // ─── Internal helpers ───

  function addEvent(event, type) {
    timeline.push({ time: new Date(currentTime), event, type });
  }

  function advance(hours) {
    currentTime = new Date(currentTime.getTime() + hours * 3600000);
  }

  /**
   * Consume on-duty-not-driving time.
   * Affects: 14-hr window, cycle hours.
   * Does NOT affect: driving hours.
   */
  function consumeOnDuty(hours) {
    windowLeft -= hours;
    cycleLeft -= hours;
  }

  /**
   * Take a 30-minute break (off-duty).
   * Affects: 14-hr window (keeps running), resets break clock.
   * Does NOT affect: driving hours, cycle hours.
   */
  function takeBreak() {
    breaksTaken++;
    addEvent("30-min break (8h driving reached)", "break");
    advance(0.5);
    windowLeft -= 0.5;   // window keeps running during off-duty
    // Off-duty: does NOT consume cycle hours or driving hours
    hoursSinceBreak = 0;
  }

  /**
   * Take a 10-hour rest.
   * Resets driving (11h) and 14-hr window (14h).
   * Does NOT reset cycle. If cycle is exhausted, returns false.
   */
  function takeRest() {
    if (cycleLeft <= 0.1) {
      hardConstraint =
        "NOT FEASIBLE — insufficient cycle hours to complete planned route. " +
        `Only ${Math.max(0, cycleLeft).toFixed(1)} cycle hours remain. ` +
        "A 34-hour restart would be needed (not modeled).";
      return false;
    }

    restStopsNeeded++;
    addEvent("Begin 10-hour rest (planning estimate)", "rest");
    advance(10);
    drivingLeft = 11;
    windowLeft = 14;
    // cycleLeft is NOT reset
    hoursSinceBreak = 0;
    addEvent("Resume after 10-hour rest", "depart");

    // Pre-trip inspection after rest
    addEvent(`Pre-trip inspection (${preTripMinutes} min)`, "stop");
    advance(preTripHours);
    consumeOnDuty(preTripHours);
    // Pre-trip is typically < 30 min; break clock already reset by rest

    return true;
  }

  /**
   * Drive a segment of the given number of miles.
   * Handles 30-min breaks and 10-hr rest insertion as needed.
   * Returns true if segment completed, false if hard constraint hit.
   *
   * @param {number} miles - Miles to drive in this segment
   * @param {string} label - Description for error messages
   */
  function driveSegment(miles, label) {
    let milesRemaining = miles;
    let safetyCounter = 0;

    while (milesRemaining > 0.05 && safetyCounter < 30) {
      safetyCounter++;

      // Check: can we drive at all?
      const availDrive = Math.min(drivingLeft, windowLeft, cycleLeft);

      if (availDrive <= 0.05) {
        // Cannot drive — need rest
        if (cycleLeft <= 0.1) {
          hardConstraint =
            `NOT FEASIBLE — cycle hours exhausted during ${label}. ` +
            `${milesRemaining.toFixed(0)} miles remaining.`;
          return false;
        }
        addEvent(
          `End driving block (HOS limit) — ${(miles - milesRemaining).toFixed(0)} mi driven`,
          "stop"
        );
        if (!takeRest()) return false;
        continue;
      }

      // Check: do we need a 30-minute break?
      if (hoursSinceBreak >= 7.95) {
        addEvent(
          `Pause driving — ${(miles - milesRemaining).toFixed(0)} mi driven so far`,
          "stop"
        );
        takeBreak();
        continue;
      }

      // Calculate how far we can drive in this block
      const hoursForRemainingMiles = milesRemaining / avgSpeed;
      const hoursUntilBreakNeeded = 8 - hoursSinceBreak;
      const driveHours = Math.min(
        availDrive,
        hoursForRemainingMiles,
        hoursUntilBreakNeeded
      );

      if (driveHours <= 0.005) continue; // floating-point guard

      const milesDriven = driveHours * avgSpeed;

      // Execute driving
      advance(driveHours);
      drivingLeft -= driveHours;
      windowLeft -= driveHours;
      cycleLeft -= driveHours;
      hoursSinceBreak += driveHours;
      milesRemaining -= milesDriven;
    }

    if (milesRemaining > 0.05) {
      hardConstraint =
        `NOT FEASIBLE — could not complete ${label}. ` +
        `${milesRemaining.toFixed(0)} miles remaining after ${safetyCounter} planning iterations.`;
      return false;
    }

    return true;
  }

  // ═══════════════════════════════════════════════════════════════════
  // CHRONOLOGICAL TRIP MODEL
  // ═══════════════════════════════════════════════════════════════════

  // ── PHASE 1: Departure + Pre-trip ──
  addEvent("Go on-duty at current location", "depart");
  addEvent(`Pre-trip inspection (${preTripMinutes} min)`, "stop");
  advance(preTripHours);
  consumeOnDuty(preTripHours);
  // Pre-trip is < 30 min, does NOT reset break clock

  // ── PHASE 2: Deadhead to pickup ──
  if (deadheadMiles > 0.5 && !hardConstraint) {
    addEvent(`Depart — deadhead to pickup (${deadheadMiles.toFixed(0)} mi)`, "depart");
    if (!driveSegment(deadheadMiles, "deadhead to pickup")) {
      return buildResult();
    }
    addEvent("Arrive at pickup", "arrive");
  } else if (!hardConstraint) {
    addEvent("At pickup location (no deadhead)", "arrive");
  }

  // ── PHASE 3: Loading ──
  if (!hardConstraint) {
    addEvent(`Begin loading (${loadingTimeHours}h est.)`, "stop");
    advance(loadingTimeHours);
    consumeOnDuty(loadingTimeHours);
    // Loading is on-duty not driving. If ≥ 0.5h (30 min), resets break clock.
    if (loadingTimeHours >= 0.5) {
      hoursSinceBreak = 0;
    }
    addEvent("Loading complete — depart pickup", "depart");
  }

  // ── PHASE 4: Drive loaded route with intermediate stops ──
  if (!hardConstraint) {
    const activeStops = (stops || []).filter(s => s); // remove null/undefined
    const numStops = activeStops.length;
    const numSegments = numStops + 1;
    const milesPerSegment = loadedMiles / numSegments;

    for (let i = 0; i < numSegments && !hardConstraint; i++) {
      const isLastSegment = i === numSegments - 1;
      const segmentLabel = isLastSegment
        ? "to delivery"
        : `to stop ${i + 1}`;

      addEvent(
        `Drive ${milesPerSegment.toFixed(0)} mi ${segmentLabel}`,
        "depart"
      );

      if (!driveSegment(milesPerSegment, segmentLabel)) {
        return buildResult();
      }

      // Intermediate stop (not for the last segment — that's delivery)
      if (!isLastSegment) {
        const stop = activeStops[i];
        const dwellHours = (stop.dwellMinutes || 30) / 60;
        const stopLabel = stop.cityState || stop.zip || `Stop ${i + 1}`;

        addEvent(`Arrive at stop ${i + 1}: ${stopLabel}`, "arrive");
        addEvent(`Dwell at stop (${(dwellHours * 60).toFixed(0)} min)`, "stop");
        advance(dwellHours);
        consumeOnDuty(dwellHours);

        // Stop dwell is on-duty not driving. If ≥ 30 min, resets break clock.
        if (dwellHours >= 0.5) {
          hoursSinceBreak = 0;
        }
      }
    }
  }

  // ── PHASE 5: Arrive at delivery ──
  if (!hardConstraint) {
    estimatedArrival = new Date(currentTime);
    addEvent("Arrive at delivery", "arrive");

    // ── PHASE 6: Unloading ──
    addEvent(`Begin unloading (${unloadingTimeHours}h est.)`, "stop");
    advance(unloadingTimeHours);
    consumeOnDuty(unloadingTimeHours);

    // ── PHASE 7: Post-trip ──
    addEvent(`Post-trip inspection (${postTripMinutes} min)`, "stop");
    advance(postTripHours);
    consumeOnDuty(postTripHours);

    addEvent("Off-duty", "rest");
  }

  return buildResult();

  // ─── Result builder ───
  function buildResult() {
    const hosRisk =
      !hardConstraint &&
      (drivingLeft < 1 || windowLeft < 1 || cycleLeft < 2);

    return {
      timeline,
      assumptions,
      estimatedArrival: estimatedArrival || new Date(currentTime),
      drivingHoursRemaining: Math.max(0, drivingLeft),
      windowRemaining: Math.max(0, windowLeft),
      cycleRemaining: Math.max(0, cycleLeft),
      hosRisk,
      hardConstraint,
      restStopsNeeded,
      breaksTaken,
      feasible: !hardConstraint,
    };
  }
}

// ─── RISK ANALYSIS ──────────────────────────────────────────────────

function evaluateRisks({
  deadheadPct,
  deliveryBufferMins,
  drivingHoursAvail,
  loadingTimeHours,
  unloadingTimeHours,
  stops,
  allMileRPM,
  equipmentType,
  tempRequired,
  hazmat,
  hosResult,
  thresholds,
}) {
  const t = thresholds;
  const risks = [];

  // Deadhead
  if (deadheadPct > t.criticalDeadheadPct) {
    risks.push({
      level: "red",
      label: "Excessive Deadhead",
      detail: `Deadhead is ${deadheadPct.toFixed(1)}% of total miles (threshold: ${t.criticalDeadheadPct}%).`,
    });
  } else if (deadheadPct > t.highDeadheadPct) {
    risks.push({
      level: "yellow",
      label: "High Deadhead",
      detail: `Deadhead is ${deadheadPct.toFixed(1)}% of total miles (threshold: ${t.highDeadheadPct}%).`,
    });
  }

  // Delivery buffer
  if (deliveryBufferMins != null && deliveryBufferMins < 0) {
    risks.push({
      level: "red",
      label: "Late Delivery Risk",
      detail: `Planning estimate shows arrival ${formatMinutes(Math.abs(deliveryBufferMins))} after appointment.`,
    });
  } else if (
    deliveryBufferMins != null &&
    deliveryBufferMins < t.tightBufferMins
  ) {
    risks.push({
      level: "yellow",
      label: "Tight Appointment",
      detail: `Delivery buffer is only ${formatMinutes(deliveryBufferMins)}.`,
    });
  }

  // HOS
  if (hosResult?.hardConstraint) {
    risks.push({
      level: "red",
      label: "HOS Hard Constraint",
      detail: hosResult.hardConstraint,
    });
  } else if (hosResult?.hosRisk) {
    risks.push({
      level: "red",
      label: "HOS Risk",
      detail: "Planning model indicates very limited remaining driving/on-duty time after delivery.",
    });
  }

  if (drivingHoursAvail < 4 && drivingHoursAvail > 0) {
    risks.push({
      level: "yellow",
      label: "Low Driving Hours",
      detail: `Only ${drivingHoursAvail.toFixed(1)} driving hours available at departure.`,
    });
  }

  // Stops
  if (stops && stops.length > 0) {
    risks.push({
      level: "yellow",
      label: "Multiple Stops",
      detail: `${stops.length} additional stop(s) increase operational complexity.`,
    });
  }

  // Dwell
  if (loadingTimeHours > t.longDwellHours) {
    risks.push({
      level: "yellow",
      label: "Long Pickup Dwell",
      detail: `Estimated loading time is ${loadingTimeHours} hours.`,
    });
  }
  if (unloadingTimeHours > t.longDwellHours) {
    risks.push({
      level: "yellow",
      label: "Long Delivery Dwell",
      detail: `Estimated unloading time is ${unloadingTimeHours} hours.`,
    });
  }

  // Equipment
  if (equipmentType === "Dry Van" && tempRequired) {
    risks.push({
      level: "red",
      label: "Equipment Conflict",
      detail:
        "Temperature-controlled freight may require reefer equipment. Verify equipment requirement.",
    });
  }
  if (hazmat) {
    risks.push({
      level: "yellow",
      label: "Hazmat Load",
      detail:
        "Verify hazmat requirements, equipment, driver credentials and company policy.",
    });
  }

  // RPM
  if (allMileRPM > 0 && allMileRPM < t.lowRPM) {
    risks.push({
      level: "yellow",
      label: "Low RPM",
      detail: `All-mile RPM of $${allMileRPM.toFixed(2)} is below threshold of $${t.lowRPM.toFixed(2)}.`,
    });
  }

  // Rest stops
  if (hosResult?.restStopsNeeded > 0) {
    risks.push({
      level: "yellow",
      label: "Rest Required",
      detail: `Planning model estimates ${hosResult.restStopsNeeded} rest stop(s) needed.`,
    });
  }

  return risks;
}

// ─── DECISION SCORE ─────────────────────────────────────────────────

/**
 * Transparent 0–100 score with per-factor breakdown.
 *
 * Factors (no overlap between categories):
 *   Feasibility (30)       — Can the driver physically complete the trip?
 *                            Based on hardConstraint and hosRisk only.
 *   Schedule Margin (20)   — How much buffer before delivery appointment?
 *                            Based on deliveryBufferMins only.
 *   Deadhead (15)          — What fraction of total miles is unpaid?
 *   RPM (20)               — Is the rate attractive per total mile?
 *   Operational Complexity (10) — Count of risk factors.
 *   Equipment/Freight (5)  — Does the freight match the equipment?
 */
function calculateDecisionScore({
  deliveryBufferMins,
  deadheadPct,
  allMileRPM,
  risks,
  hosResult,
  equipmentConflict,
  thresholds,
}) {
  const breakdown = [];

  // Feasibility (30 pts) — physical possibility only, NOT schedule comfort
  let feasibility = 30;
  if (hosResult?.hardConstraint) {
    feasibility = 0;
  } else if (!hosResult?.feasible && hosResult != null) {
    feasibility = 0;
  } else if (hosResult?.hosRisk) {
    feasibility -= 15;
  }
  feasibility = Math.max(0, feasibility);
  breakdown.push({ label: "Feasibility", points: feasibility, max: 30 });

  // Schedule Margin (20 pts) — delivery buffer only
  let margin = 20;
  if (deliveryBufferMins != null) {
    if (deliveryBufferMins < 0) margin = 0;
    else if (deliveryBufferMins < 30) margin = 5;
    else if (deliveryBufferMins < 60) margin = 10;
    else if (deliveryBufferMins < 120) margin = 15;
    // ≥120 min: full 20 points
  }
  breakdown.push({ label: "Schedule Margin", points: margin, max: 20 });

  // Deadhead (15 pts)
  let dh = 15;
  if (deadheadPct > 30) dh -= 10;
  else if (deadheadPct > 20) dh -= 7;
  else if (deadheadPct > 10) dh -= 3;
  dh = Math.max(0, dh);
  breakdown.push({ label: "Deadhead", points: dh, max: 15 });

  // RPM (20 pts)
  let rpm = 20;
  if (allMileRPM > 0 && allMileRPM < thresholds.lowRPM) rpm -= 12;
  else if (allMileRPM > 0 && allMileRPM < thresholds.lowRPM * 1.2) rpm -= 6;
  rpm = Math.max(0, rpm);
  breakdown.push({ label: "RPM", points: rpm, max: 20 });

  // Operational Complexity (10 pts)
  let complexity = 10;
  const redRisks = risks.filter((r) => r.level === "red").length;
  const yellowRisks = risks.filter((r) => r.level === "yellow").length;
  complexity -= redRisks * 4;
  complexity -= yellowRisks * 1.5;
  complexity = Math.max(0, Math.round(complexity));
  breakdown.push({ label: "Operational Complexity", points: complexity, max: 10 });

  // Equipment/Freight (5 pts)
  let equip = 5;
  if (equipmentConflict) equip = 0;
  breakdown.push({ label: "Equipment / Freight", points: equip, max: 5 });

  const total = breakdown.reduce((s, b) => s + b.points, 0);
  const viability =
    total >= 75 ? "green" : total >= 50 ? "yellow" : "red";
  const viabilityLabel =
    total >= 75
      ? "VIABLE"
      : total >= 50
        ? "TIGHT"
        : "NOT VIABLE / HIGH RISK";

  return { total, breakdown, viability, viabilityLabel };
}

// ─── FORMATTING HELPERS ─────────────────────────────────────────────

function formatCurrency(val) {
  if (val == null || isNaN(val)) return "$0";
  return (
    "$" +
    val.toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })
  );
}

function formatCurrencyDecimal(val) {
  if (val == null || isNaN(val)) return "$0.00";
  return "$" + val.toFixed(2);
}

function formatMinutes(mins) {
  if (mins == null || isNaN(mins)) return "—";
  const neg = mins < 0;
  const abs = Math.abs(mins);
  const h = Math.floor(abs / 60);
  const m = Math.round(abs % 60);
  return (neg ? "-" : "") + (h > 0 ? `${h}h ` : "") + `${m}m`;
}

function formatTime(date) {
  if (!date) return "—";
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDateTime(date) {
  if (!date) return "—";
  return (
    date.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    }) +
    " " +
    formatTime(date)
  );
}

// ─── NEGOTIATION STRATEGY ───────────────────────────────────────────

/**
 * Calculates a transparent negotiation strategy based on the operation's
 * own configurable economic thresholds. Does NOT claim to know market rates.
 *
 * Strategy (inverse approach):
 *   "What rate would make this load meet target economics?"
 *   targetRate    = totalMiles × targetRPM
 *   minimumRate   = totalMiles × minimumRPM
 *   suggestedCounter = targetRate × (1 + negotiationPremium)
 *
 * All rates rounded to nearest rounding increment (default $25).
 *
 * @param {Object} params
 * @param {number} params.totalMiles
 * @param {number} params.loadedMiles
 * @param {number} params.offeredRate
 * @param {number} params.targetRPM          - Configurable target $/mi
 * @param {number} params.minimumRPM         - Configurable minimum $/mi
 * @param {number} params.negotiationPremium - Fraction above target for opening (e.g. 0.05 = 5%)
 * @param {number} params.roundingIncrement  - Round rates to this (default 25)
 * @returns {Object}
 */
function calculateNegotiationStrategy({
  totalMiles,
  loadedMiles,
  offeredRate,
  targetRPM,
  minimumRPM,
  negotiationPremium = 0.05,
  roundingIncrement = 25,
}) {
  if (!totalMiles || totalMiles <= 0 || !offeredRate || offeredRate <= 0) {
    return null;
  }

  function roundTo(val, inc) {
    return Math.round(val / inc) * inc;
  }

  const offeredAllMileRPM = offeredRate / totalMiles;
  const offeredLoadedRPM = loadedMiles > 0 ? offeredRate / loadedMiles : 0;

  const rawTarget = totalMiles * targetRPM;
  const rawMinimum = totalMiles * minimumRPM;
  const rawCounter = rawTarget * (1 + negotiationPremium);

  const targetRate = roundTo(rawTarget, roundingIncrement);
  const minimumRate = roundTo(rawMinimum, roundingIncrement);
  let suggestedCounter = roundTo(rawCounter, roundingIncrement);

  // Counter should not be below the offered rate
  if (suggestedCounter < offeredRate) {
    suggestedCounter = offeredRate;
  }

  // Counter should not be below target
  if (suggestedCounter < targetRate) {
    suggestedCounter = targetRate;
  }

  const counterAllMileRPM = suggestedCounter / totalMiles;
  const targetAllMileRPM = targetRate / totalMiles;
  const minimumAllMileRPM = minimumRate / totalMiles;

  // Determine rate quality relative to thresholds
  const aboveTarget = offeredRate >= targetRate;
  const aboveMinimum = offeredRate >= minimumRate;
  const belowMinimum = offeredRate < minimumRate;

  // Build rationale
  const rationale = [];
  if (aboveTarget) {
    rationale.push("Offered rate already meets or exceeds target RPM — strong economics.");
  } else if (aboveMinimum) {
    rationale.push("Offered rate is between minimum and target RPM — room to negotiate.");
  } else {
    rationale.push("Offered rate is below minimum acceptable RPM — significant negotiation needed.");
  }

  rationale.push(`Target based on: ${totalMiles} total mi × $${targetRPM.toFixed(2)}/mi = ${formatCurrency(targetRate)}.`);
  rationale.push(`Minimum based on: ${totalMiles} total mi × $${minimumRPM.toFixed(2)}/mi = ${formatCurrency(minimumRate)}.`);

  if (!aboveTarget) {
    rationale.push(`Counter opens at target + ${(negotiationPremium * 100).toFixed(0)}% premium = ${formatCurrency(suggestedCounter)}.`);
  }

  return {
    offeredRate,
    offeredAllMileRPM,
    offeredLoadedRPM,
    targetRate,
    targetAllMileRPM,
    minimumRate,
    minimumAllMileRPM,
    suggestedCounter,
    counterAllMileRPM,
    aboveTarget,
    aboveMinimum,
    belowMinimum,
    rationale,
  };
}

// ─── DAILY MILEAGE ──────────────────────────────────────────────────

/**
 * Calculates loaded miles per operational day.
 * Operational days = number of calendar dates the load spans (minimum 1).
 *
 * Pickup Sep 4, Delivery Sep 4 → 1 day
 * Pickup Sep 4, Delivery Sep 5 → 2 days
 * Pickup Sep 4, Delivery Sep 6 → 3 days
 *
 * @param {number} loadedMiles
 * @param {Date|null} pickupDateTime
 * @param {Date|null} deliveryDateTime
 * @returns {Object|null}
 */
function calculateDailyMileage(loadedMiles, pickupDateTime, deliveryDateTime) {
  if (!loadedMiles || loadedMiles <= 0 || !pickupDateTime || !deliveryDateTime) {
    return null;
  }

  // Count calendar days between the two dates
  const pickupDay = new Date(pickupDateTime.getFullYear(), pickupDateTime.getMonth(), pickupDateTime.getDate());
  const deliveryDay = new Date(deliveryDateTime.getFullYear(), deliveryDateTime.getMonth(), deliveryDateTime.getDate());
  const diffMs = deliveryDay.getTime() - pickupDay.getTime();
  const diffDays = Math.round(diffMs / 86400000);
  const operationalDays = Math.max(1, diffDays + 1);

  const milesPerDay = loadedMiles / operationalDays;

  return {
    operationalDays,
    milesPerDay,
    loadedMiles,
  };
}

/**
 * Evaluates daily mileage against target.
 *
 * @param {Object} dailyMileage - from calculateDailyMileage
 * @param {number} target - daily miles target (default 500)
 * @param {number} exceptionRPM - RPM above which short loads are acceptable
 * @param {number} allMileRPM - current all-mile RPM
 * @returns {Object}
 */
function evaluateDailyMileageTarget(dailyMileage, target, exceptionRPM, allMileRPM) {
  if (!dailyMileage) return null;

  const { milesPerDay, operationalDays, loadedMiles } = dailyMileage;
  const belowTarget = milesPerDay < target;
  const rpmException = allMileRPM >= exceptionRPM;
  const pctOfTarget = (milesPerDay / target) * 100;

  let level = "green";
  let label = "On target";

  if (belowTarget && rpmException) {
    level = "green";
    label = "Below mileage target — strong rate exception applies";
  } else if (belowTarget && pctOfTarget >= 80) {
    level = "yellow";
    label = "Slightly below mileage target";
  } else if (belowTarget) {
    level = "yellow";
    label = "Below daily mileage target";
  }

  return {
    milesPerDay,
    operationalDays,
    target,
    pctOfTarget,
    belowTarget,
    rpmException,
    level,
    label,
  };
}

// ─── RELOAD RISK ────────────────────────────────────────────────────

/**
 * Checks whether the delivery destination is in a configured avoided state.
 *
 * @param {string} deliveryCityState - e.g. "Atlanta, GA"
 * @param {Array} avoidedStates - [{code: "FL", severity: "warning"|"strong"|"block"}]
 * @returns {Object|null}
 */
function evaluateReloadRisk(deliveryCityState, avoidedStates) {
  if (!deliveryCityState || !avoidedStates || avoidedStates.length === 0) {
    return null;
  }

  // Extract state from "City, ST" or "ST" format
  const parts = deliveryCityState.trim().split(/[,\s]+/);
  const stateCode = parts[parts.length - 1]?.toUpperCase();

  if (!stateCode || stateCode.length !== 2) return null;

  const match = avoidedStates.find(
    (s) => s.code.toUpperCase() === stateCode
  );

  if (!match) return null;

  return {
    state: stateCode,
    severity: match.severity || "warning",
    isAvoided: true,
  };
}

// ─── EXPORTS ────────────────────────────────────────────────────────

module.exports = {
  calculateTotalMiles,
  calculateLoadedRPM,
  calculateAllMilesRPM,
  calculateDeadheadPercentage,
  calculateEstimatedDrivingTime,
  calculateDeliveryBuffer,
  parseTimeToHours,
  parseDateTimeInputs,
  evaluateHOSPlanning,
  evaluateRisks,
  calculateDecisionScore,
  calculateNegotiationStrategy,
  calculateDailyMileage,
  evaluateDailyMileageTarget,
  evaluateReloadRisk,
  formatCurrency,
  formatCurrencyDecimal,
  formatMinutes,
  formatTime,
  formatDateTime,
};
